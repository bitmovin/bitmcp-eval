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

/** A scripted agent: per message, performs the given tool calls through the proxy. */
function scriptedAgent(script: Record<string, string[]>): Agent {
  let requestId = 0;
  return {
    name: 'scripted',
    createSession(mcpUrl) {
      return {
        async send(message) {
          for (const tool of script[message] ?? []) {
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
          return { text: `answered: ${message}`, isError: false };
        },
      };
    },
  };
}

function makeConfig(mcpUrl: string, iterations: number): EvalConfig {
  return {
    mcp: { url: mcpUrl, headers: [] },
    testcases: { source: 'filesystem', path: '/unused' },
    run: { iterations, agents: ['claude'], timeoutSeconds: 60 },
    report: { outDir: '/unused' },
  };
}

const CASES: TestCase[] = [
  { name: 'passing', prompt: 'p1', expectedTools: ['query'], answers: [], file: '/t/p1.yaml' },
  { name: 'failing', prompt: 'p2', expectedTools: ['query', 'queryTotal'], answers: [], file: '/t/p2.yaml' },
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
      agents: [agent],
      events: {
        onProxyStarted: () => events.push('proxy'),
        onTestCaseStart: (tc) => events.push(`start:${tc.name}`),
        onIterationEnd: (_tc, it) => events.push(`iter:${it.iteration}:${it.passed}`),
        onTestCaseEnd: (r) => events.push(`end:${r.testCase.name}:${r.passRate}`),
      },
    });

    const report = await runner.run();

    expect(report.status).toBe('completed');
    expect(report.plannedTestCases).toBe(2);
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
      createSession() {
        return {
          async send() {
            calls++;
            if (calls === 1) throw new Error('agent exploded');
            return { text: 'ok but called nothing', isError: false };
          },
        };
      },
    };

    const runner = new EvalRunner({
      config: makeConfig(upstream.url, 2),
      testCases: [CASES[0]],
      agents: [flakyAgent],
    });
    const report = await runner.run();

    expect(report.totals.failedIterations).toBe(2);
    expect(report.results[0].iterations[0].error).toContain('agent exploded');
    expect(report.results[0].iterations[1].error).toBeUndefined();
    expect(report.results[0].iterations[1].passed).toBe(false); // expected tool not called
  });

  it('answers clarifying questions with the scripted answers until expectations are met', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    // Turn 1 only lists licenses and asks back; the scripted answer unlocks the real queries.
    const agent = scriptedAgent({
      'show me the funnel': ['peekAllLicenses'],
      'use the license with the most plays': ['query', 'query'],
    });

    const testCase: TestCase = {
      name: 'clarifying question',
      prompt: 'show me the funnel',
      expectedTools: ['peekAllLicenses', 'query', 'query'],
      answers: ['use the license with the most plays', 'never needed'],
      file: '/t/funnel.yaml',
    };

    const runner = new EvalRunner({ config: makeConfig(upstream.url, 1), testCases: [testCase], agents: [agent] });
    const report = await runner.run();
    const iteration = report.results[0].iterations[0];

    expect(iteration.passed).toBe(true);
    // Only the first answer was needed; the second was never sent.
    expect(iteration.turns.map((t) => t.message)).toEqual([
      'show me the funnel',
      'use the license with the most plays',
    ]);
    expect(iteration.toolCalls.map((c) => c.name)).toEqual(['peekAllLicenses', 'query', 'query']);
  });

  it('does not send answers when the first turn already satisfies the expectations', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const agent = scriptedAgent({ p1: ['query'] });
    const testCase: TestCase = { ...CASES[0], answers: ['should never be sent'] };

    const runner = new EvalRunner({ config: makeConfig(upstream.url, 1), testCases: [testCase], agents: [agent] });
    const report = await runner.run();
    const iteration = report.results[0].iterations[0];

    expect(iteration.passed).toBe(true);
    expect(iteration.turns).toHaveLength(1);
  });

  it('fails when the answers run out before the expectations are met', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const agent = scriptedAgent({ p2: ['query'], 'answer 1': [] });
    const testCase: TestCase = { ...CASES[1], answers: ['answer 1'] };

    const runner = new EvalRunner({ config: makeConfig(upstream.url, 1), testCases: [testCase], agents: [agent] });
    const report = await runner.run();
    const iteration = report.results[0].iterations[0];

    expect(iteration.passed).toBe(false);
    expect(iteration.turns).toHaveLength(2);
    expect(iteration.validation.expectations).toContainEqual({
      name: 'queryTotal',
      expected: 1,
      actual: 0,
      satisfied: false,
    });
  });

  it('runs the whole suite once per agent and reports per-agent totals', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const goodAgent = { ...scriptedAgent({ p1: ['query'], p2: ['query', 'queryTotal'] }), name: 'good' };
    const badAgent = { ...scriptedAgent({}), name: 'bad' }; // never calls anything
    const agentOrder: string[] = [];

    const runner = new EvalRunner({
      config: makeConfig(upstream.url, 1),
      testCases: CASES,
      agents: [goodAgent, badAgent],
      events: {
        onAgentStart: (agent, index, total) => agentOrder.push(`${agent}:${index}/${total}`),
      },
    });

    const report = await runner.run();

    expect(agentOrder).toEqual(['good:0/2', 'bad:1/2']);
    expect(report.agents).toEqual(['good', 'bad']);
    expect(report.plannedTestCases).toBe(4); // 2 test cases × 2 agents
    expect(report.results.map((r) => `${r.agent}:${r.testCase.name}:${r.passRate}`)).toEqual([
      'good:passing:1',
      'good:failing:1',
      'bad:passing:0',
      'bad:failing:0',
    ]);
    expect(report.totals).toEqual({ testCases: 4, iterations: 4, passedIterations: 2, failedIterations: 2 });
    expect(report.perAgent).toEqual([
      { agent: 'good', testCases: 2, iterations: 2, passedIterations: 2, failedIterations: 0 },
      { agent: 'bad', testCases: 2, iterations: 2, passedIterations: 0, failedIterations: 2 },
    ]);
  });

  it('emits a running report snapshot after every finished test case', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const snapshots: Array<{ status: string; done: number; planned: number }> = [];
    const runner = new EvalRunner({
      config: makeConfig(upstream.url, 1),
      testCases: CASES,
      agents: [scriptedAgent({ p1: ['query'], p2: ['query'] })],
      events: {
        onReportUpdate: (r) =>
          snapshots.push({ status: r.status, done: r.totals.testCases, planned: r.plannedTestCases }),
      },
    });

    const finalReport = await runner.run();

    expect(snapshots).toEqual([
      { status: 'running', done: 1, planned: 2 },
      { status: 'running', done: 2, planned: 2 },
    ]);
    expect(finalReport.status).toBe('completed');
  });
});
