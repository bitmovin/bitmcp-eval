import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createAuthSession,
  discoverOAuth,
  generatePkce,
  parseResourceMetadataUrl,
  refreshTokens,
  TokenStore,
  type OAuthServerInfo,
  type StoredAuth,
} from '../src/oauth.js';

const INFO: OAuthServerInfo = {
  issuer: 'https://as.example',
  authorizationEndpoint: 'https://as.example/oauth2/authorize',
  tokenEndpoint: 'https://as.example/oauth2/token',
  registrationEndpoint: 'https://as.example/oauth2/register',
  resource: 'https://mcp.example',
};

/** Minimal fetch stub mapping "METHOD url" → a JSON response. */
function fakeFetch(routes: Record<string, { status?: number; headers?: Record<string, string>; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    const route = routes[`${init?.method ?? 'GET'} ${url}`] ?? routes[url];
    if (!route) throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return {
      status: route.status ?? 200,
      ok: (route.status ?? 200) < 400,
      headers: new Headers(route.headers ?? {}),
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('generatePkce', () => {
  it('derives an S256 challenge from the verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(challenge).toBe(createHash('sha256').update(verifier).digest().toString('base64url'));
  });
});

describe('parseResourceMetadataUrl', () => {
  it('extracts resource_metadata from a WWW-Authenticate challenge', () => {
    const header = 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", error="x"';
    expect(parseResourceMetadataUrl(header)).toBe('https://mcp.example/.well-known/oauth-protected-resource');
  });
  it('returns undefined when absent', () => {
    expect(parseResourceMetadataUrl('Bearer')).toBeUndefined();
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes PKCE, state, and the resource indicator (RFC 8707)', () => {
    const url = new URL(
      buildAuthorizeUrl(INFO, {
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:8765/callback',
        challenge: 'chal',
        state: 'st',
        scopes: ['a', 'b'],
      }),
    );
    expect(url.origin + url.pathname).toBe('https://as.example/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 'st',
      resource: 'https://mcp.example',
      scope: 'a b',
    });
  });
});

describe('discoverOAuth', () => {
  it('returns null when the server does not answer with 401 (non-OAuth server)', async () => {
    const { impl } = fakeFetch({ 'POST https://mcp.example/mcp': { status: 200, body: {} } });
    expect(await discoverOAuth('https://mcp.example/mcp', impl)).toBeNull();
  });

  it('follows the 401 → protected-resource → authorization-server chain', async () => {
    const { impl } = fakeFetch({
      'POST https://mcp.example/mcp': {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
        },
      },
      'https://mcp.example/.well-known/oauth-protected-resource': {
        body: { resource: 'https://mcp.example', authorization_servers: ['https://as.example'] },
      },
      'https://as.example/.well-known/oauth-authorization-server': {
        body: {
          issuer: 'https://as.example',
          authorization_endpoint: 'https://as.example/oauth2/authorize',
          token_endpoint: 'https://as.example/oauth2/token',
          registration_endpoint: 'https://as.example/oauth2/register',
        },
      },
    });
    expect(await discoverOAuth('https://mcp.example/mcp', impl)).toEqual({
      issuer: 'https://as.example',
      authorizationEndpoint: 'https://as.example/oauth2/authorize',
      tokenEndpoint: 'https://as.example/oauth2/token',
      registrationEndpoint: 'https://as.example/oauth2/register',
      resource: 'https://mcp.example',
      scopesSupported: undefined,
    });
  });
});

describe('refreshTokens', () => {
  it('posts the refresh grant and keeps the old refresh token when none is rotated back', async () => {
    const stored: StoredAuth = {
      accessToken: 'old',
      refreshToken: 'r1',
      issuer: INFO.issuer,
      resource: INFO.resource,
      tokenEndpoint: INFO.tokenEndpoint,
      clientId: 'cid',
      clientSecret: 'sec',
    };
    const { impl, calls } = fakeFetch({
      'POST https://as.example/oauth2/token': { body: { access_token: 'new', expires_in: 3600 } },
    });
    const result = await refreshTokens(stored, INFO.resource, impl, 1_000_000);
    expect(result.accessToken).toBe('new');
    expect(result.refreshToken).toBe('r1'); // preserved
    expect(result.expiresAt).toBe(1_000_000 + 3600 * 1000 - 60_000);
    const body = calls[0].init!.body!.toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('resource=https%3A%2F%2Fmcp.example');
  });
});

describe('TokenStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bitmcp-eval-tokens-'));
  });

  it('round-trips stored auth keyed per issuer/resource', () => {
    const store = new TokenStore(dir);
    const auth: StoredAuth = {
      accessToken: 'a',
      issuer: 'i',
      resource: 'r',
      tokenEndpoint: 't',
      clientId: 'c',
    };
    expect(store.load('i|r')).toBeNull();
    store.save('i|r', auth);
    expect(store.load('i|r')).toEqual(auth);
    expect(store.load('other')).toBeNull();
  });
});

describe('createAuthSession', () => {
  const discoveryRoutes = {
    'POST https://mcp.example/mcp': {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
      },
    },
    'https://mcp.example/.well-known/oauth-protected-resource': {
      body: { resource: 'https://mcp.example', authorization_servers: ['https://as.example'] },
    },
    'https://as.example/.well-known/oauth-authorization-server': {
      body: {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/oauth2/authorize',
        token_endpoint: 'https://as.example/oauth2/token',
      },
    },
  };

  it('returns null for a non-OAuth server', async () => {
    const { impl } = fakeFetch({ 'POST https://mcp.example/mcp': { status: 200, body: {} } });
    const session = await createAuthSession({
      mcpUrl: 'https://mcp.example/mcp',
      interactive: false,
      deps: { fetchImpl: impl },
    });
    expect(session).toBeNull();
  });

  it('uses a valid cached token without any login', async () => {
    const store = new TokenStore(await mkdtemp(join(tmpdir(), 'bitmcp-eval-tokens-')));
    store.save('https://as.example|https://mcp.example', {
      accessToken: 'cached',
      issuer: 'https://as.example',
      resource: 'https://mcp.example',
      tokenEndpoint: 'https://as.example/oauth2/token',
      clientId: 'c',
      expiresAt: 10_000_000,
    });
    const { impl } = fakeFetch(discoveryRoutes);
    const session = await createAuthSession({
      mcpUrl: 'https://mcp.example/mcp',
      interactive: false,
      store,
      deps: { fetchImpl: impl, now: () => 1_000_000 },
    });
    expect(await session!.getAuthHeader()).toBe('Bearer cached');
  });

  it('refreshes an expired cached token silently', async () => {
    const store = new TokenStore(await mkdtemp(join(tmpdir(), 'bitmcp-eval-tokens-')));
    store.save('https://as.example|https://mcp.example', {
      accessToken: 'stale',
      refreshToken: 'r1',
      issuer: 'https://as.example',
      resource: 'https://mcp.example',
      tokenEndpoint: 'https://as.example/oauth2/token',
      clientId: 'c',
      expiresAt: 500, // already expired at now=1_000_000
    });
    const { impl } = fakeFetch({
      ...discoveryRoutes,
      'POST https://as.example/oauth2/token': { body: { access_token: 'fresh', expires_in: 3600 } },
    });
    const session = await createAuthSession({
      mcpUrl: 'https://mcp.example/mcp',
      interactive: false,
      store,
      deps: { fetchImpl: impl, now: () => 1_000_000 },
    });
    expect(await session!.getAuthHeader()).toBe('Bearer fresh');
  });

  it('errors instead of prompting when non-interactive and no token is cached', async () => {
    const { impl } = fakeFetch(discoveryRoutes);
    await expect(
      createAuthSession({
        mcpUrl: 'https://mcp.example/mcp',
        interactive: false,
        store: new TokenStore(await mkdtemp(join(tmpdir(), 'bitmcp-eval-tokens-'))),
        deps: { fetchImpl: impl },
      }),
    ).rejects.toThrow(/login required/i);
  });

  it('performs an interactive login (DCR + code exchange) when allowed', async () => {
    const { impl } = fakeFetch({
      ...discoveryRoutes,
      // this AS advertises dynamic client registration
      'https://as.example/.well-known/oauth-authorization-server': {
        body: {
          issuer: 'https://as.example',
          authorization_endpoint: 'https://as.example/oauth2/authorize',
          token_endpoint: 'https://as.example/oauth2/token',
          registration_endpoint: 'https://as.example/oauth2/register',
        },
      },
      'POST https://as.example/oauth2/register': { body: { client_id: 'dcr-client', client_secret: 'dcr-secret' } },
      'POST https://as.example/oauth2/token': {
        body: { access_token: 'logged-in', refresh_token: 'r', expires_in: 3600 },
      },
    });
    const session = await createAuthSession({
      mcpUrl: 'https://mcp.example/mcp',
      interactive: true,
      store: new TokenStore(await mkdtemp(join(tmpdir(), 'bitmcp-eval-tokens-'))),
      deps: {
        fetchImpl: impl,
        openBrowser: () => {},
        onAuthUrl: () => {},
        awaitCallback: async () => ({ code: 'auth-code' }),
      },
    });
    expect(await session!.getAuthHeader()).toBe('Bearer logged-in');
  });
});
