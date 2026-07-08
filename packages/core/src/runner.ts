import type { Agent, AgentSession } from './agent.js';
import type { EvalConfig } from './config.js';
import { judgeIteration, type JudgeResult } from './judge.js';
import { McpRecordingProxy, type ProxyRequestInfo, type ToolCallRecord } from './proxy.js';
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
  /**
   * Ways the agent left the MCP binding (shell commands, web searches) —
   * reported by agents that cannot be hard-restricted (codex). Escapes do not
   * fail an iteration by themselves: answering *instead of* calling the
   * expected tools already fails validation, while e.g. shell-based math on
   * top of proper tool results is legitimate. They are surfaced so failed
   * bindings are explainable at a glance.
   */
  escapes: string[];
  /** The full conversation: initial prompt plus any scripted answers that were needed. */
  turns: ConversationTurn[];
  /**
   * Independent LLM verdict on this iteration, when a judge is configured.
   * Advisory only — it never changes `passed`.
   */
  judge?: JudgeResult;
  /** The agent's final answer, when it produced one. */
  agentResponse?: string;
  /** Set when the agent invocation itself failed (crash, timeout, agent-side error). */
  error?: string;
  durationMs: number;
}

export interface TestCaseResult {
  /** Name of the agent this result was produced with. */
  agent: string;
  testCase: TestCase;
  iterations: IterationResult[];
  /** Fraction of iterations that passed, 0..1. */
  passRate: number;
}

export interface RunTotals {
  testCases: number;
  iterations: number;
  passedIterations: number;
  failedIterations: number;
}

export interface EvalRunReport {
  /**
   * `running` for the incremental snapshots emitted during the run,
   * `completed` for the final report, `aborted` when the run was cancelled.
   */
  status: 'running' | 'completed' | 'aborted';
  startedAt: string;
  /** For running snapshots: the time of the snapshot. */
  finishedAt: string;
  mcpUrl: string;
  /** The agents this run evaluates; the suite runs once per agent. */
  agents: string[];
  iterationsPerTestCase: number;
  /** How many test case runs are planned in total (test cases × agents). */
  plannedTestCases: number;
  /** Results of the test case runs finished so far (all of them, once completed). */
  results: TestCaseResult[];
  totals: RunTotals;
  /** Totals broken down per agent, in run order. */
  perAgent: Array<RunTotals & { agent: string }>;
}

function computeTotals(results: TestCaseResult[]): RunTotals {
  const iterations = results.flatMap((r) => r.iterations);
  return {
    testCases: results.length,
    iterations: iterations.length,
    passedIterations: iterations.filter((it) => it.passed).length,
    failedIterations: iterations.filter((it) => !it.passed).length,
  };
}

/** Progress callbacks so a UI can render the run live. All are optional. */
export interface RunnerEvents {
  onProxyStarted?(proxyUrl: string, targetUrl: string): void;
  /** Fired for every request the proxy forwards upstream — headers contain secrets, handle with care. */
  onProxyRequest?(info: ProxyRequestInfo): void;
  /** Fired when the suite starts for the next agent. */
  onAgentStart?(agent: string, index: number, total: number): void;
  onTestCaseStart?(testCase: TestCase, index: number, total: number, agent: string): void;
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
  /** The suite is executed once per agent, in order. */
  agents: Agent[];
  /** Supplies the Authorization header for OAuth-protected servers (see createAuthSession). */
  authProvider?: () => Promise<string | undefined>;
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
    const { config, testCases, agents, events } = this.opts;
    const startedAt = new Date();
    const plannedTestCases = testCases.length * agents.length;

    const proxy = new McpRecordingProxy({
      targetUrl: config.mcp.url,
      injectionHeaders: config.mcp.headers,
      authProvider: this.opts.authProvider,
      onRecord: (rec) => events?.onToolCall?.(rec),
      onRequest: (info) => events?.onProxyRequest?.(info),
    });

    const { url: proxyUrl } = await proxy.start();
    events?.onProxyStarted?.(proxyUrl, config.mcp.url);

    const results: TestCaseResult[] = [];
    try {
      for (const [agentIndex, agent] of agents.entries()) {
        events?.onAgentStart?.(agent.name, agentIndex, agents.length);

        for (const [index, testCase] of testCases.entries()) {
          events?.onTestCaseStart?.(testCase, index, testCases.length, agent.name);

          const iterations: IterationResult[] = [];
          for (let i = 1; i <= config.run.iterations; i++) {
            events?.onIterationStart?.(testCase, i, config.run.iterations);
            proxy.clear();
            iterations.push(await this.runIteration(testCase, i, proxy, proxyUrl, agent));
            events?.onIterationEnd?.(testCase, iterations[iterations.length - 1]);
          }

          const result: TestCaseResult = {
            agent: agent.name,
            testCase,
            iterations,
            passRate: iterations.filter((it) => it.passed).length / iterations.length,
          };
          results.push(result);
          events?.onTestCaseEnd?.(result);
          events?.onReportUpdate?.(this.buildReport('running', startedAt, results, plannedTestCases));
        }
      }
    } finally {
      await proxy.stop();
    }

    return this.buildReport('completed', startedAt, results, plannedTestCases);
  }

  private buildReport(
    status: EvalRunReport['status'],
    startedAt: Date,
    results: TestCaseResult[],
    plannedTestCases: number,
  ): EvalRunReport {
    const { config, agents } = this.opts;
    return {
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mcpUrl: config.mcp.url,
      agents: agents.map((a) => a.name),
      iterationsPerTestCase: config.run.iterations,
      plannedTestCases,
      // shallow copy so later mutation never leaks into an already-emitted snapshot
      results: [...results],
      totals: computeTotals(results),
      perAgent: agents
        .map((a) => ({ agent: a.name, ...computeTotals(results.filter((r) => r.agent === a.name)) }))
        .filter((t) => t.testCases > 0),
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
    const session = agent.createSession(proxyUrl, { timeoutMs: config.run.timeoutSeconds * 1000 });
    let result: IterationResult;
    try {
      result = await this.runConversation(testCase, iteration, proxy, session);
    } finally {
      await session.close?.();
    }

    if (config.judge) {
      // Advisory second opinion; judgeIteration never throws (errors become
      // verdict "error"), so a broken judge annotates instead of breaking runs.
      result.judge = await judgeIteration(config.judge, testCase, result);
    }
    return result;
  }

  private async runConversation(
    testCase: TestCase,
    iteration: number,
    proxy: McpRecordingProxy,
    session: AgentSession,
  ): Promise<IterationResult> {
    const started = performance.now();
    const turns: ConversationTurn[] = [];
    const escapes: string[] = [];
    let error: string | undefined;

    const sendTurn = async (message: string): Promise<void> => {
      const turn: ConversationTurn = { message };
      turns.push(turn);
      try {
        const result = await session.send(message);
        turn.response = result.text;
        escapes.push(...(result.escapes ?? []));
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
        proxy.getRecords().map((c) => ({ name: c.name, ok: c.ok })),
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
      escapes,
      turns,
      agentResponse: turns[turns.length - 1]?.response,
      error,
      durationMs: performance.now() - started,
    };
  }
}
