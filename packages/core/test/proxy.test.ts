import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { McpRecordingProxy, type ToolCallRecord } from '../src/proxy.js';

interface FakeUpstream {
  url: string;
  seenHeaders: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** A fake MCP server answering every tools/call with a canned JSON-RPC response. */
function startFakeUpstream(mode: 'json' | 'sse' | 'tool-error'): Promise<FakeUpstream> {
  const seenHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    seenHeaders.push(req.headers);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result:
        mode === 'tool-error'
          ? { content: [{ type: 'text', text: '401 Unauthorized' }], isError: true }
          : { content: [{ type: 'text', text: 'sunny, 24°C' }] },
    };

    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        seenHeaders,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function toolsCallBody(id: number, name: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

describe('McpRecordingProxy', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup(mode: 'json' | 'sse' | 'tool-error', injectionHeaders?: { name: string; value: string }[]) {
    const upstream = await startFakeUpstream(mode);
    cleanups.push(upstream.close);
    const records: ToolCallRecord[] = [];
    const proxy = new McpRecordingProxy({
      targetUrl: upstream.url,
      injectionHeaders,
      onRecord: (rec) => records.push(rec),
    });
    const { url } = await proxy.start();
    cleanups.push(() => proxy.stop());
    return { upstream, proxy, proxyUrl: url, records };
  }

  it('relays a JSON response untouched and records the tool call', async () => {
    const { proxy, proxyUrl, records } = await setup('json');

    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toolsCallBody(1, 'get_current_weather', { city: 'Vienna' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result.content[0].text).toBe('sunny, 24°C');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: 'get_current_weather',
      args: { city: 'Vienna' },
      ok: true,
    });
    expect(proxy.getRecords()).toHaveLength(1);
  });

  it('parses SSE responses and still records the tool call', async () => {
    const { proxyUrl, records } = await setup('sse');

    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: toolsCallBody(7, 'get_forecast', { city: 'Berlin', days: 3 }),
    });
    const text = await res.text();

    expect(text).toContain('data:');
    // SSE parsing happens as the stream drains; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'get_forecast', args: { city: 'Berlin', days: 3 }, ok: true });
  });

  it('injects configured headers into upstream requests', async () => {
    const { upstream, proxyUrl } = await setup('json', [{ name: 'X-Api-Key', value: 'secret-123' }]);

    await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toolsCallBody(2, 'list_supported_cities', {}),
    });

    expect(upstream.seenHeaders[0]['x-api-key']).toBe('secret-123');
  });

  it('records MCP tool-level errors (result.isError) as failed calls', async () => {
    const { records, proxyUrl } = await setup('tool-error');

    await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toolsCallBody(9, 'peekAllLicenses', {}),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'peekAllLicenses', ok: false });
  });

  it('ignores non-tool-call messages', async () => {
    const { proxyUrl, records } = await setup('json');

    await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    expect(records).toHaveLength(0);
  });

  it('clear() resets the recorded calls', async () => {
    const { proxy, proxyUrl } = await setup('json');
    await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toolsCallBody(3, 'get_current_weather', { city: 'London' }),
    });
    expect(proxy.getRecords()).toHaveLength(1);
    proxy.clear();
    expect(proxy.getRecords()).toHaveLength(0);
  });
});
