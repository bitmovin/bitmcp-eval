import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

/** One completed tool invocation, as observed on the wire. */
export interface ToolCallRecord {
  id: string | number;
  name: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
  error?: unknown;
  startedAt: number; // performance.now() when the request crossed the proxy
  durationMs: number;
}

export type InjectionHeader = {
  name: string;
  value: string;
};

export interface ProxyOptions {
  /** Where the real MCP server listens, e.g. "http://127.0.0.1:3000/mcp". */
  targetUrl: string;
  /** Proxy listen port. 0 (default) = pick a free port. */
  port?: number;
  /** Called for every completed tools/call. */
  onRecord?: (rec: ToolCallRecord) => void;

  // Any headers which we must inject to the mcp server calls?
  // E.g. authentication headers? x-api-key?
  injectionHeaders?: InjectionHeader[];
}

type Pending = { name: string; args: unknown; startedAt: number };

/**
 * A recording reverse proxy for StreamableHTTP MCP servers.
 *
 * Point your chat-agent's MCP config at this proxy's URL instead of the real
 * server. Every JSON-RPC message is forwarded byte-for-byte; a copy is parsed
 * to record `tools/call` invocations and their results.
 *
 *   const proxy = new McpRecordingProxy({ targetUrl: "http://127.0.0.1:3000/mcp" });
 *   const { url } = await proxy.start();   // -> point the agent here
 *   ... run claude -p / codex exec ...
 *   await proxy.stop();
 *   const calls = proxy.getRecords();
 */
export class McpRecordingProxy {
  private server?: http.Server;
  private records: ToolCallRecord[] = [];

  constructor(private readonly opts: ProxyOptions) {}

  getRecords(): ToolCallRecord[] {
    return this.records;
  }

  clear(): void {
    this.records = [];
  }

  async start(): Promise<{ port: number; url: string }> {
    const target = new URL(this.opts.targetUrl);
    this.server = http.createServer((req, res) => {
      this.handle(req, res, target).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(this.opts.port ?? 0, '127.0.0.1', resolve));

    const port = (this.server!.address() as AddressInfo).port;
    return { port, url: `http://127.0.0.1:${port}${target.pathname}` };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((e) => (e ? reject(e) : resolve())));
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, target: URL): Promise<void> {
    // MCP requests are always a single JSON body (or none for GET) — never
    // streamed — so it's safe to buffer the request fully.
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyBuf = Buffer.concat(chunks);

    // Sniff the request for tool calls: id -> { name, args, startedAt }.
    // Scoped per-exchange so ids never collide across requests.
    const pending = new Map<string | number, Pending>();
    if (bodyBuf.length) {
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          if (m?.method === 'tools/call' && m.id !== undefined) {
            pending.set(m.id, {
              name: m.params?.name,
              args: m.params?.arguments,
              startedAt: performance.now(),
            });
          }
        }
      } catch {
        /* not JSON (e.g. a GET) — nothing to record */
      }
    }

    // Forward headers verbatim except hop-by-hop / length (fetch recomputes).
    // Crucially this preserves Accept, Mcp-Session-Id and Mcp-Protocol-Version,
    // so both stateless and stateful servers work transparently.
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (key === 'host' || key === 'connection' || key === 'content-length') continue;
      fwdHeaders[key] = Array.isArray(v) ? v.join(', ') : v;
    }

    for (const header of this.opts.injectionHeaders ?? []) {
      fwdHeaders[header.name.toLowerCase()] = header.value;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());

    const method = req.method ?? 'GET';
    const upstream = await fetch(target.toString(), {
      method,
      headers: fwdHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : bodyBuf,
      signal: ac.signal,
    });

    // Relay status + headers back to the agent.
    const resHeaders: Record<string, string> = {};
    upstream.headers.forEach((val, key) => {
      if (key === 'content-length' || key === 'connection' || key === 'transfer-encoding') {
        return;
      }
      resHeaders[key] = val;
    });
    res.writeHead(upstream.status, resHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    const ctype = upstream.headers.get('content-type') ?? '';

    if (ctype.includes('text/event-stream')) {
      // SSE: tee — one branch to the agent untouched, one branch we parse.
      const [toClient, toParse] = upstream.body.tee();
      Readable.fromWeb(toClient as import('node:stream/web').ReadableStream).pipe(res);
      await this.parseSse(toParse, pending);
    } else {
      // Single JSON response: buffer, forward, parse.
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          this.onMessage(m, pending);
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  }

  /** Parse an SSE stream, dispatching each `data:` payload as JSON-RPC. */
  private async parseSse(stream: ReadableStream<Uint8Array>, pending: Map<string | number, Pending>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let dataLines: string[] = [];

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);

          if (line === '') {
            // event boundary — flush accumulated data lines as one message
            if (dataLines.length) {
              const payload = dataLines.join('\n');
              dataLines = [];
              try {
                this.onMessage(JSON.parse(payload), pending);
              } catch {
                /* ignore */
              }
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          // event:, id:, retry:, and `:` comments are ignored
        }
      }
    } catch {
      /* upstream closed / aborted */
    }
  }

  /** Match a JSON-RPC response against a pending tool call and record it. */
  private onMessage(message: unknown, pending: Map<string | number, Pending>): void {
    const m = message as { id?: string | number; result?: unknown; error?: unknown };
    if (m?.id === undefined || !pending.has(m.id)) return;
    if (m.result === undefined && m.error === undefined) return; // not a response

    const call = pending.get(m.id)!;
    pending.delete(m.id);

    const rec: ToolCallRecord = {
      id: m.id,
      name: call.name,
      args: call.args,
      ok: m.error === undefined,
      result: m.result,
      error: m.error,
      startedAt: call.startedAt,
      durationMs: performance.now() - call.startedAt,
    };
    this.records.push(rec);
    this.opts.onRecord?.(rec);
  }
}
