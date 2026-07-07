import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** OAuth endpoints discovered for an MCP server. */
export interface OAuthServerInfo {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Present when the server supports dynamic client registration (RFC 7591). */
  registrationEndpoint?: string;
  /** The protected resource the token is minted for (RFC 8707 audience). */
  resource: string;
  scopesSupported?: string[];
}

/** Static-client fallback config, used when the server has no DCR endpoint. */
export interface OAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Fixed loopback port for the redirect URI (must match a registered client's URI). */
  redirectPort?: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token should be treated as expired (with skew). */
  expiresAt?: number;
}

/** Everything needed to refresh without re-discovering. Persisted to the token cache. */
export interface StoredAuth extends TokenSet {
  issuer: string;
  resource: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
}

/** A live token holder that refreshes silently as it nears expiry. */
export interface AuthSession {
  /** Current `Authorization` header value, refreshed on demand. */
  getAuthHeader(): Promise<string>;
}

const DEFAULT_REDIRECT_PORT = 8765;
const EXPIRY_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Extracts the `resource_metadata` URL from a WWW-Authenticate challenge, if present. */
export function parseResourceMetadataUrl(wwwAuthenticate: string): string | undefined {
  return /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1];
}

/**
 * Detects whether an MCP server requires OAuth and, if so, returns its
 * endpoints. Returns null for servers that answer without a 401 (e.g. API-key
 * or unauthenticated servers) — the caller then skips OAuth entirely.
 */
export async function discoverOAuth(mcpUrl: string, fetchImpl: typeof fetch = fetch): Promise<OAuthServerInfo | null> {
  let res: Response;
  try {
    res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bitmcp-eval', version: '1' } },
      }),
    });
  } catch {
    return null; // unreachable now — the run will surface the connection error later
  }

  if (res.status !== 401) return null;

  const prmUrl =
    parseResourceMetadataUrl(res.headers.get('www-authenticate') ?? '') ??
    new URL('/.well-known/oauth-protected-resource', mcpUrl).toString();

  const prm = (await (await fetchImpl(prmUrl)).json()) as { resource?: string; authorization_servers?: string[] };
  const asBase = prm.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  const resource = prm.resource ?? new URL(mcpUrl).origin;

  const asMetaUrl = new URL('/.well-known/oauth-authorization-server', asBase).toString();
  const as = (await (await fetchImpl(asMetaUrl)).json()) as {
    issuer?: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
  };

  return {
    issuer: as.issuer ?? asBase,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    resource,
    scopesSupported: as.scopes_supported,
  };
}

// ---------------------------------------------------------------------------
// Client registration, authorize URL, token exchange, refresh
// ---------------------------------------------------------------------------

export async function registerClient(
  info: OAuthServerInfo,
  redirectUri: string,
  scopes: string[] | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!info.registrationEndpoint) {
    throw new Error(
      'The MCP server does not support dynamic client registration. ' +
        'Register an OAuth client manually and set mcp.oauth.clientId / clientSecret in the config ' +
        `(allow the redirect URI ${redirectUri}).`,
    );
  }
  const res = await fetchImpl(info.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'bitmcp-eval',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Dynamic client registration failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

export function buildAuthorizeUrl(
  info: OAuthServerInfo,
  params: { clientId: string; redirectUri: string; challenge: string; state: string; scopes?: string[] },
): string {
  const url = new URL(info.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('resource', info.resource);
  if (params.scopes?.length) url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

function tokenSetFrom(
  json: { access_token: string; refresh_token?: string; expires_in?: number },
  now: number,
): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? now + json.expires_in * 1000 - EXPIRY_SKEW_MS : undefined,
  };
}

export async function exchangeCode(
  info: OAuthServerInfo,
  params: { code: string; redirectUri: string; verifier: string; clientId: string; clientSecret?: string },
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
    client_id: params.clientId,
    resource: info.resource,
  });
  if (params.clientSecret) body.set('client_secret', params.clientSecret);
  const res = await fetchImpl(info.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return tokenSetFrom(await res.json(), now);
}

export async function refreshTokens(
  stored: StoredAuth,
  resource: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  if (!stored.refreshToken) throw new Error('No refresh token available');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
    resource,
  });
  if (stored.clientSecret) body.set('client_secret', stored.clientSecret);
  const res = await fetchImpl(stored.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  const next = tokenSetFrom(await res.json(), now);
  // Some servers omit a rotated refresh token; keep the previous one then.
  return { ...next, refreshToken: next.refreshToken ?? stored.refreshToken };
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

/** Persists tokens per (issuer, resource) so one login serves many configs and survives restarts. */
export class TokenStore {
  constructor(private readonly dir: string = join(homedir(), '.bitmcp-eval', 'tokens')) {}

  private pathFor(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  load(key: string): StoredAuth | null {
    try {
      return JSON.parse(readFileSync(this.pathFor(key), 'utf8')) as StoredAuth;
    } catch {
      return null;
    }
  }

  save(key: string, auth: StoredAuth): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(key);
    writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600); // ensure 0600 even if the file pre-existed
  }
}

// ---------------------------------------------------------------------------
// Interactive login
// ---------------------------------------------------------------------------

/** Injectable side effects, so the browser/loopback dance can be faked in tests. */
export interface LoginDeps {
  fetchImpl?: typeof fetch;
  /** Open the system browser at the authorization URL. */
  openBrowser?: (url: string) => void;
  /** Surface the URL to the user (for headless/SSH, they open it manually). */
  onAuthUrl?: (url: string) => void;
  /** Wait for the OAuth redirect and return the authorization code. */
  awaitCallback?: (port: number, state: string) => Promise<{ code: string }>;
  now?: () => number;
}

function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* headless — the user opens the printed URL manually */
  }
}

/** Runs a one-shot loopback server that captures the OAuth redirect. */
function defaultAwaitCallback(port: number, state: string): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html' });
      const ok = code && returnedState === state;
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">` +
          `<h2>${ok ? 'bitmcp-eval is authorized ✅' : 'Authorization failed ❌'}</h2>` +
          `<p>You can close this tab and return to the terminal.</p>`,
      );
      server.close();
      if (!code) reject(new Error(`Authorization failed: ${url.searchParams.get('error') ?? 'no code returned'}`));
      else if (returnedState !== state) reject(new Error('OAuth state mismatch — aborting for safety'));
      else resolve({ code });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

/** Performs a full interactive authorization-code + PKCE login. */
export async function interactiveLogin(
  info: OAuthServerInfo,
  config: OAuthClientConfig,
  deps: LoginDeps = {},
): Promise<StoredAuth> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const port = config.redirectPort ?? DEFAULT_REDIRECT_PORT;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const scopes = config.scopes ?? info.scopesSupported;

  let { clientId, clientSecret } = config;
  if (!clientId) {
    ({ clientId, clientSecret } = await registerClient(info, redirectUri, scopes, fetchImpl));
  }

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString('base64url');
  const authUrl = buildAuthorizeUrl(info, { clientId, redirectUri, challenge, state, scopes });

  const waitForCode = (deps.awaitCallback ?? defaultAwaitCallback)(port, state);
  (deps.onAuthUrl ?? ((u) => console.log(`\nOpen this URL to authorize bitmcp-eval:\n  ${u}\n`)))(authUrl);
  (deps.openBrowser ?? defaultOpenBrowser)(authUrl);

  const { code } = await waitForCode;
  const tokens = await exchangeCode(info, { code, redirectUri, verifier, clientId, clientSecret }, fetchImpl, now());

  return {
    ...tokens,
    issuer: info.issuer,
    resource: info.resource,
    tokenEndpoint: info.tokenEndpoint,
    clientId,
    clientSecret,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface CreateAuthSessionOptions {
  mcpUrl: string;
  config?: OAuthClientConfig;
  /** Whether an interactive browser login may be triggered (false in CI/non-TTY). */
  interactive: boolean;
  store?: TokenStore;
  deps?: LoginDeps;
}

/**
 * Returns an {@link AuthSession} for an OAuth-protected MCP server, or null
 * when the server needs no OAuth. Uses a cached token when valid, refreshes it
 * silently when possible, and only falls back to interactive login when
 * allowed. The returned session keeps refreshing on demand for the run's life.
 */
export async function createAuthSession(opts: CreateAuthSessionOptions): Promise<AuthSession | null> {
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const now = opts.deps?.now ?? Date.now;
  const store = opts.store ?? new TokenStore();

  const info = await discoverOAuth(opts.mcpUrl, fetchImpl);
  if (!info) return null;

  const key = `${info.issuer}|${info.resource}`;
  let current = store.load(key);

  const expired = (a: StoredAuth): boolean => a.expiresAt !== undefined && now() >= a.expiresAt;

  if (current && expired(current)) {
    if (current.refreshToken) {
      current = { ...current, ...(await refreshTokens(current, info.resource, fetchImpl, now())) };
      store.save(key, current);
    } else {
      current = null; // can't refresh — force a fresh login below
    }
  }

  if (!current) {
    if (!opts.interactive) {
      throw new Error(
        `OAuth login required for ${opts.mcpUrl} but no valid cached token was found. ` +
          `Run \`bitmcp-eval login -c <config>\` first.`,
      );
    }
    current = await interactiveLogin(info, opts.config ?? {}, opts.deps);
    store.save(key, current);
  }

  let refreshing: Promise<void> | undefined;
  return {
    async getAuthHeader(): Promise<string> {
      if (expired(current!) && current!.refreshToken) {
        // single-flight: concurrent proxied requests share one refresh
        refreshing ??= (async () => {
          current = { ...current!, ...(await refreshTokens(current!, info.resource, fetchImpl, now())) };
          store.save(key, current);
        })().finally(() => (refreshing = undefined));
        await refreshing;
      }
      return `Bearer ${current!.accessToken}`;
    },
  };
}
