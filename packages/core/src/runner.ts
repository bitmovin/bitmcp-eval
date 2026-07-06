import type { Agent } from './agent.js';
import type { EvalConfig } from './config.js';
import { McpRecordingProxy, type ToolCallRecord } from './proxy.js';
import type { TestCase } from './testcase.js';
import { validateToolCalls, type ValidationResult } from './validate.js';

/** One user → agent exchange within an iteration's conversation. */
export interface ConversationTurn {
  /** What the harness sent: the test case prompt, or one of its `answers`. */
  message: string;
  /** The agent's reply for this turn. */
  response?: string;
}

export interface IterationResult {
  /** 1-based iteration number. */
  iteration: number;
  passed: boolean;
  validation: ValidationResult;
  toolCalls: ToolCallRecord[];
  /** The full conversation: initial prompt plus any scripted answers that were needed. */
  turns: ConversationTurn[];
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
  /** `running` for the incremental snapshots emitted during the run, `completed` for the final report. */
  status: 'running' | 'completed';
  startedAt: string;
  /** For running snapshots: the time of the snapshot. */
  finishedAt: string;
  mcpUrl: string;
  agent: string;
  iterationsPerTestCase: number;
  /** How many test cases the run will execute in total. */
  plannedTestCases: number;
  /** Results of the test cases finished so far (all of them, once completed). */
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
  /**
   * Fired after every finished test case with a `running` snapshot covering
   * all results so far — write it out to get a live, incrementally updated report.
   */
  onReportUpdate?(report: EvalRunReport): void;
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
        events?.onReportUpdate?.(this.buildReport('running', startedAt, results, testCases.length));
      }
    } finally {
      await proxy.stop();
    }

    return this.buildReport('completed', startedAt, results, testCases.length);
  }

  private buildReport(
    status: EvalRunReport['status'],
    startedAt: Date,
    results: TestCaseResult[],
    plannedTestCases: number,
  ): EvalRunReport {
    const { config, agent } = this.opts;
    const allIterations = results.flatMap((r) => r.iterations);
    return {
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mcpUrl: config.mcp.url,
      agent: agent.name,
      iterationsPerTestCase: config.run.iterations,
      plannedTestCases,
      // shallow copy so later mutation never leaks into an already-emitted snapshot
      results: [...results],
      totals: {
        testCases: results.length,
        iterations: allIterations.length,
        passedIterations: allIterations.filter((it) => it.passed).length,
        failedIterations: allIterations.filter((it) => !it.passed).length,
      },
    };
  }

  /**
   * Runs one iteration as a conversation: the prompt first, then — while the
   * tool expectations are unmet and scripted `answers` remain — one answer per
   * extra turn, so the agent can get past clarifying questions it asks.
   */
  private async runIteration(
    testCase: TestCase,
    iteration: number,
    proxy: McpRecordingProxy,
    proxyUrl: string,
    agent: Agent,
  ): Promise<IterationResult> {
    const { config } = this.opts;
    const started = performance.now();

    const session = agent.createSession(proxyUrl, { timeoutMs: config.run.timeoutSeconds * 1000 });
    const turns: ConversationTurn[] = [];
    let error: string | undefined;

    const sendTurn = async (message: string): Promise<void> => {
      const turn: ConversationTurn = { message };
      turns.push(turn);
      try {
        const result = await session.send(message);
        turn.response = result.text;
        if (result.isError) {
          error = `Agent reported an error result: ${result.text}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    };

    const validate = (): ValidationResult =>
      validateToolCalls(
        testCase.expectedTools,
        proxy.getRecords().map((c) => c.name),
      );

    await sendTurn(testCase.prompt);
    let validation = validate();

    for (const answer of testCase.answers) {
      if (error !== undefined || validation.passed) break;
      await sendTurn(answer);
      validation = validate();
    }

    const toolCalls = [...proxy.getRecords()];
    return {
      iteration,
      passed: validation.passed && error === undefined,
      validation,
      toolCalls,
      turns,
      agentResponse: turns[turns.length - 1]?.response,
      error,
      durationMs: performance.now() - started,
    };
  }
}
