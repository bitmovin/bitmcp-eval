import type { Agent } from './agent.js';
import type { EvalConfig } from './config.js';
import { McpRecordingProxy, type ToolCallRecord } from './proxy.js';
import type { TestCase } from './testcase.js';
import { validateToolCalls, type ValidationResult } from './validate.js';

export interface IterationResult {
  /** 1-based iteration number. */
  iteration: number;
  passed: boolean;
  validation: ValidationResult;
  toolCalls: ToolCallRecord[];
  /** The agent's final answer, when it produced one. */
  agentResponse?: string;
  /** Set when the agent invocation itself failed (crash, timeout, agent-side error). */
  error?: string;
  durationMs: number;
}

export interface TestCaseResult {
  testCase: TestCase;
  iterations: IterationResult[];
  /** Fraction of iterations that passed, 0..1. */
  passRate: number;
}

export interface EvalRunReport {
  startedAt: string;
  finishedAt: string;
  mcpUrl: string;
  agent: string;
  iterationsPerTestCase: number;
  results: TestCaseResult[];
  totals: {
    testCases: number;
    iterations: number;
    passedIterations: number;
    failedIterations: number;
  };
}

/** Progress callbacks so a UI can render the run live. All are optional. */
export interface RunnerEvents {
  onProxyStarted?(proxyUrl: string, targetUrl: string): void;
  onTestCaseStart?(testCase: TestCase, index: number, total: number): void;
  onIterationStart?(testCase: TestCase, iteration: number, iterations: number): void;
  onToolCall?(record: ToolCallRecord): void;
  onIterationEnd?(testCase: TestCase, result: IterationResult): void;
  onTestCaseEnd?(result: TestCaseResult): void;
}

export interface EvalRunnerOptions {
  config: EvalConfig;
  testCases: TestCase[];
  agent: Agent;
  events?: RunnerEvents;
}

/**
 * Orchestrates one evaluation run: starts the recording proxy in front of the
 * MCP server under test, executes every test case `iterations` times through
 * the agent, and validates the recorded tool calls against the expectations.
 */
export class EvalRunner {
  constructor(private readonly opts: EvalRunnerOptions) {}

  async run(): Promise<EvalRunReport> {
    const { config, testCases, agent, events } = this.opts;
    const startedAt = new Date();

    const proxy = new McpRecordingProxy({
      targetUrl: config.mcp.url,
      injectionHeaders: config.mcp.headers,
      onRecord: (rec) => events?.onToolCall?.(rec),
    });

    const { url: proxyUrl } = await proxy.start();
    events?.onProxyStarted?.(proxyUrl, config.mcp.url);

    const results: TestCaseResult[] = [];
    try {
      for (const [index, testCase] of testCases.entries()) {
        events?.onTestCaseStart?.(testCase, index, testCases.length);

        const iterations: IterationResult[] = [];
        for (let i = 1; i <= config.run.iterations; i++) {
          events?.onIterationStart?.(testCase, i, config.run.iterations);
          proxy.clear();
          iterations.push(await this.runIteration(testCase, i, proxy, proxyUrl, agent));
          events?.onIterationEnd?.(testCase, iterations[iterations.length - 1]);
        }

        const result: TestCaseResult = {
          testCase,
          iterations,
          passRate: iterations.filter((it) => it.passed).length / iterations.length,
        };
        results.push(result);
        events?.onTestCaseEnd?.(result);
      }
    } finally {
      await proxy.stop();
    }

    const allIterations = results.flatMap((r) => r.iterations);
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mcpUrl: config.mcp.url,
      agent: agent.name,
      iterationsPerTestCase: config.run.iterations,
      results,
      totals: {
        testCases: results.length,
        iterations: allIterations.length,
        passedIterations: allIterations.filter((it) => it.passed).length,
        failedIterations: allIterations.filter((it) => !it.passed).length,
      },
    };
  }

  private async runIteration(
    testCase: TestCase,
    iteration: number,
    proxy: McpRecordingProxy,
    proxyUrl: string,
    agent: Agent,
  ): Promise<IterationResult> {
    const { config } = this.opts;
    const started = performance.now();

    let agentResponse: string | undefined;
    let error: string | undefined;
    try {
      const result = await agent.run(testCase.prompt, proxyUrl, {
        timeoutMs: config.run.timeoutSeconds * 1000,
      });
      agentResponse = result.text;
      if (result.isError) {
        error = `Agent reported an error result: ${result.text}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const toolCalls = [...proxy.getRecords()];
    const validation = validateToolCalls(
      testCase.expectedTools,
      toolCalls.map((c) => c.name),
    );

    return {
      iteration,
      passed: validation.passed && error === undefined,
      validation,
      toolCalls,
      agentResponse,
      error,
      durationMs: performance.now() - started,
    };
  }
}
