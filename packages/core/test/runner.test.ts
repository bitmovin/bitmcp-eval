import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent.js';
import type { EvalConfig } from '../src/config.js';
import { EvalRunner } from '../src/runner.js';
import type { TestCase } from '../src/testcase.js';

/** Fake upstream MCP server that answers every tools/call successfully. */
function startUpstream(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [] } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A scripted agent: per prompt, performs the given tool calls through the proxy. */
function scriptedAgent(script: Record<string, string[]>): Agent {
  let requestId = 0;
  return {
    name: 'scripted',
    async run(prompt, mcpUrl) {
      for (const tool of script[prompt] ?? []) {
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++requestId,
            method: 'tools/call',
            params: { name: tool, arguments: {} },
          }),
        });
      }
      return { text: `answered: ${prompt}`, isError: false };
    },
  };
}

function makeConfig(mcpUrl: string, iterations: number): EvalConfig {
  return {
    mcp: { url: mcpUrl, headers: [] },
    testcases: { source: 'filesystem', path: '/unused' },
    run: { iterations, agent: 'claude', timeoutSeconds: 60 },
    report: { outDir: '/unused' },
  };
}

const CASES: TestCase[] = [
  { name: 'passing', prompt: 'p1', expectedTools: ['query'], file: '/t/p1.yaml' },
  { name: 'failing', prompt: 'p2', expectedTools: ['query', 'queryTotal'], file: '/t/p2.yaml' },
];

describe('EvalRunner', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('runs every test case N times, validates tool calls, and aggregates totals', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const agent = scriptedAgent({ p1: ['query'], p2: ['query'] }); // p2 misses queryTotal
    const events: string[] = [];

    const runner = new EvalRunner({
      config: makeConfig(upstream.url, 2),
      testCases: CASES,
      agent,
      events: {
        onProxyStarted: () => events.push('proxy'),
        onTestCaseStart: (tc) => events.push(`start:${tc.name}`),
        onIterationEnd: (_tc, it) => events.push(`iter:${it.iteration}:${it.passed}`),
        onTestCaseEnd: (r) => events.push(`end:${r.testCase.name}:${r.passRate}`),
      },
    });

    const report = await runner.run();

    expect(report.totals).toEqual({ testCases: 2, iterations: 4, passedIterations: 2, failedIterations: 2 });
    expect(report.results[0].passRate).toBe(1);
    expect(report.results[1].passRate).toBe(0);

    const failedIteration = report.results[1].iterations[0];
    expect(failedIteration.validation.expectations).toContainEqual({
      name: 'queryTotal',
      expected: 1,
      actual: 0,
      satisfied: false,
    });
    expect(failedIteration.agentResponse).toBe('answered: p2');
    // tool calls recorded per-iteration, not accumulated across iterations
    expect(report.results.flatMap((r) => r.iterations).every((it) => it.toolCalls.length === 1)).toBe(true);

    expect(events).toEqual([
      'proxy',
      'start:passing',
      'iter:1:true',
      'iter:2:true',
      'end:passing:1',
      'start:failing',
      'iter:1:false',
      'iter:2:false',
      'end:failing:0',
    ]);
  });

  it('marks an iteration as failed when the agent throws, and keeps running', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    let calls = 0;
    const flakyAgent: Agent = {
      name: 'flaky',
      async run() {
        calls++;
        if (calls === 1) throw new Error('agent exploded');
        return { text: 'ok but called nothing', isError: false };
      },
    };

    const runner = new EvalRunner({
      config: makeConfig(upstream.url, 2),
      testCases: [CASES[0]],
      agent: flakyAgent,
    });
    const report = await runner.run();

    expect(report.totals.failedIterations).toBe(2);
    expect(report.results[0].iterations[0].error).toContain('agent exploded');
    expect(report.results[0].iterations[1].error).toBeUndefined();
    expect(report.results[0].iterations[1].passed).toBe(false); // expected tool not called
  });
});
