import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import {
  createAgent,
  createAuthSession,
  judgeDisagrees,
  loadConfig,
  loadTestCases,
  writeHtmlReport,
  EvalRunner,
  type EvalConfig,
  type EvalRunReport,
  type ProxyRequestInfo,
  type TestCase,
  type TestCaseResult,
} from '@bitmcp-eval/core';
import { Header, IterationMarks, ProgressBar, Spinner } from './components.js';
import ConfigSummary from './config_summary.js';

type Phase = 'loading' | 'running' | 'done' | 'error';

interface CurrentIteration {
  agent: string;
  testCase: TestCase;
  index: number;
  total: number;
  iteration: number;
  iterations: number;
  /** Pass/fail of the already-finished iterations of this test case. */
  finished: boolean[];
  /** Tool names recorded so far in the running iteration. */
  liveToolCalls: string[];
}

export interface AppProps {
  configPath: string;
  iterationsOverride?: number;
  /** Log proxied request headers (secrets included) to a file in the report dir. */
  debug?: boolean;
}

export default function App({ configPath, iterationsOverride, debug }: AppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [config, setConfig] = useState<EvalConfig | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentIteration | null>(null);
  const [completed, setCompleted] = useState<TestCaseResult[]>([]);
  const [report, setReport] = useState<{ report: EvalRunReport; htmlPath: string } | null>(null);
  const [liveReportPath, setLiveReportPath] = useState<string | null>(null);
  const [debugLogPath, setDebugLogPath] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const started = useRef(false);
  // Report writes go to the same file; chain them so snapshots never interleave.
  const reportWrites = useRef<Promise<unknown>>(Promise.resolve());
  const lastSnapshot = useRef<{ snapshot: EvalRunReport; outDir: string } | null>(null);

  // Ctrl-C: freeze the live report as "aborted" (stops its auto-refresh) before exiting.
  useEffect(() => {
    const onSigint = () => {
      const last = lastSnapshot.current;
      if (!last) process.exit(130);
      writeHtmlReport({ ...last.snapshot, status: 'aborted' }, last.outDir)
        .catch(() => undefined)
        .finally(() => process.exit(130));
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, []);

  useEffect(() => {
    if (started.current) return; // guard against double-mount in dev/StrictMode
    started.current = true;

    (async () => {
      const cfg = loadConfig(configPath);
      if (iterationsOverride !== undefined) {
        cfg.run.iterations = iterationsOverride;
      }
      setConfig(cfg);

      const cases = await loadTestCases(cfg.testcases.path);
      setTestCases(cases);

      // Auto-detect OAuth; only prompts for a browser login when there is no
      // usable cached/refreshable token. Returns null for non-OAuth servers.
      const authSession = await createAuthSession({
        mcpUrl: cfg.mcp.url,
        config: cfg.mcp.oauth,
        interactive: Boolean(process.stdout.isTTY),
        deps: { onAuthUrl: (url) => setAuthUrl(url) },
      });
      setAuthUrl(null);
      setPhase('running');

      let logProxyRequest: ((info: ProxyRequestInfo) => void) | undefined;
      if (debug) {
        mkdirSync(cfg.report.outDir, { recursive: true });
        const logPath = join(cfg.report.outDir, 'bitmcp-eval-debug.log');
        appendFileSync(logPath, `\n--- run started ${new Date().toISOString()} (headers contain secrets!) ---\n`);
        setDebugLogPath(logPath);
        logProxyRequest = (info) => {
          const tools = info.toolNames.length ? ` tools/call [${info.toolNames.join(', ')}]` : '';
          const headers = Object.entries(info.headers)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          appendFileSync(logPath, `${new Date().toISOString()} ${info.method}${tools} | ${headers}\n`);
        };
      }

      const runner = new EvalRunner({
        config: cfg,
        testCases: cases,
        agents: cfg.run.agents.map(createAgent),
        authProvider: authSession ? () => authSession.getAuthHeader() : undefined,
        events: {
          onProxyStarted: (url) => setProxyUrl(url),
          onProxyRequest: logProxyRequest,
          onTestCaseStart: (testCase, index, total, agent) =>
            setCurrent({
              agent,
              testCase,
              index,
              total,
              iteration: 1,
              iterations: cfg.run.iterations,
              finished: [],
              liveToolCalls: [],
            }),
          onIterationStart: (_testCase, iteration) =>
            setCurrent((c) => (c ? { ...c, iteration, liveToolCalls: [] } : c)),
          onToolCall: (record) =>
            setCurrent((c) => (c ? { ...c, liveToolCalls: [...c.liveToolCalls, record.name] } : c)),
          onIterationEnd: (_testCase, result) =>
            setCurrent((c) => (c ? { ...c, finished: [...c.finished, result.passed] } : c)),
          onTestCaseEnd: (result) => {
            setCompleted((prev) => [...prev, result]);
            setCurrent(null); // its iterations are now counted via `completed`
          },
          onReportUpdate: (snapshot) => {
            lastSnapshot.current = { snapshot, outDir: cfg.report.outDir };
            reportWrites.current = reportWrites.current
              .then(() => writeHtmlReport(snapshot, cfg.report.outDir))
              .then((path) => setLiveReportPath(path))
              .catch(() => undefined); // a failed snapshot write never kills the run
          },
        },
      });

      const runReport = await runner.run();
      lastSnapshot.current = null; // run finished; Ctrl-C no longer needs an abort write
      await reportWrites.current; // let the last live snapshot land before the final write
      const htmlPath = await writeHtmlReport(runReport, cfg.report.outDir);
      setCurrent(null);
      setReport({ report: runReport, htmlPath });
      setPhase('done');
    })().catch((err: unknown) => {
      setError(err instanceof Error ? err : new Error(String(err)));
      setPhase('error');
    });
  }, [configPath, iterationsOverride, debug]);

  useEffect(() => {
    if (phase === 'done') exit();
    if (phase === 'error' && error) exit(error);
  }, [phase, error, exit]);

  if (phase === 'error' && error) {
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Text color="red" bold>
          Evaluation failed
        </Text>
        <Text color="red">{error.message}</Text>
      </Box>
    );
  }

  const iterationsDone = completed.reduce((n, r) => n + r.iterations.length, 0) + (current?.finished.length ?? 0);
  const iterationsTotal = testCases.length * (config?.run.iterations ?? 1) * (config?.run.agents.length ?? 1);
  const multiAgent = (config?.run.agents.length ?? 1) > 1;

  return (
    <Box flexDirection="column">
      <Static items={completed}>
        {(result) => (
          <CompletedTestCaseRow
            key={`${result.agent}:${result.testCase.file}`}
            result={result}
            showAgent={multiAgent}
          />
        )}
      </Static>

      <Header title="bitmcp-eval — MCP evaluation run" />

      {config ? <ConfigSummary config={config} /> : <Spinner label={`Loading config from ${configPath}…`} />}

      {authUrl && (
        <Box flexDirection="column" marginY={1}>
          <Text>
            <Text color="yellow">⚠</Text> This MCP server requires OAuth. Opening your browser to authorize…
          </Text>
          <Text>
            If it doesn&apos;t open, visit: <Text color="blue">{authUrl}</Text>
          </Text>
        </Box>
      )}

      {config &&
        (proxyUrl ? (
          <Text>
            <Text color="green">●</Text> Recording proxy <Text color="blue">{proxyUrl}</Text>
            <Text dimColor> → </Text>
            <Text color="green">{config.mcp.url}</Text>
          </Text>
        ) : (
          phase === 'running' && <Spinner label="Starting recording proxy…" />
        ))}

      {debugLogPath && (
        <Text>
          <Text color="yellow">⚠</Text> Debug log: <Text color="blue">{debugLogPath}</Text>{' '}
          <Text dimColor>(request headers incl. secrets — do not share)</Text>
        </Text>
      )}

      {phase === 'running' && testCases.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <ProgressBar done={iterationsDone} total={iterationsTotal} />
            <Text>
              {' '}
              {iterationsDone}/{iterationsTotal} iterations
            </Text>
          </Box>
          {liveReportPath && (
            <Text>
              Live report: <Text color="blue">file://{liveReportPath}</Text>{' '}
              <Text dimColor>(updates per test case)</Text>
            </Text>
          )}
          {current && (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                <Text dimColor>
                  [{current.index + 1}/{current.total}]
                </Text>{' '}
                {multiAgent && <Text color="cyan">({current.agent}) </Text>}
                <Text bold>{current.testCase.name}</Text> <IterationMarks passes={current.finished} />
              </Text>
              <Text dimColor italic>
                “{truncate(current.testCase.prompt, 80)}”
              </Text>
              <Box>
                <Spinner
                  label={`iteration ${current.iteration}/${current.iterations}${
                    current.liveToolCalls.length ? `  tools: ${current.liveToolCalls.join(', ')}` : ''
                  }`}
                />
              </Box>
            </Box>
          )}
        </Box>
      )}

      {phase === 'done' && report && <RunSummary report={report.report} htmlPath={report.htmlPath} />}
    </Box>
  );
}

function CompletedTestCaseRow({ result, showAgent }: { result: TestCaseResult; showAgent: boolean }) {
  const allPassed = result.iterations.every((it) => it.passed);
  const disagreements = result.iterations.filter((it) => judgeDisagrees(it.passed, it.judge)).length;
  return (
    <Text>
      <Text color={allPassed ? 'green' : 'red'}>{allPassed ? '✓' : '✗'}</Text>{' '}
      {showAgent && <Text color="cyan">({result.agent}) </Text>}
      {result.testCase.name} <IterationMarks passes={result.iterations.map((it) => it.passed)} />
      <Text dimColor>
        {' '}
        ({result.iterations.filter((it) => it.passed).length}/{result.iterations.length} passed)
      </Text>
      {disagreements > 0 && <Text color="magenta"> ⚖ judge disagrees ×{disagreements}</Text>}
    </Text>
  );
}

function RunSummary({ report, htmlPath }: { report: EvalRunReport; htmlPath: string }) {
  const { totals } = report;
  const passRate = totals.iterations === 0 ? 0 : Math.round((totals.passedIterations / totals.iterations) * 100);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" paddingLeft={1} paddingRight={1} flexDirection="column" alignSelf="flex-start">
        <Text bold>Run finished</Text>
        <Text>
          {totals.testCases} test case runs · {totals.iterations} iterations ·{' '}
          <Text color="green">{totals.passedIterations} passed</Text> ·{' '}
          <Text color={totals.failedIterations > 0 ? 'red' : undefined}>{totals.failedIterations} failed</Text> ·{' '}
          <Text bold color={passRate === 100 ? 'green' : passRate >= 50 ? 'yellow' : 'red'}>
            {passRate}% pass rate
          </Text>
        </Text>
        {report.agents.length > 1 &&
          report.perAgent.map((t) => (
            <Text key={t.agent}>
              {'  '}
              <Text color="cyan">{t.agent}</Text>: {t.passedIterations}/{t.iterations} passed (
              <Text bold>{t.iterations === 0 ? '—' : `${Math.round((t.passedIterations / t.iterations) * 100)}%`}</Text>
              )
            </Text>
          ))}
        <JudgeSummary report={report} />
        <Text>
          Report: <Text color="blue">file://{htmlPath}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function JudgeSummary({ report }: { report: EvalRunReport }) {
  const judged = report.results.flatMap((r) => r.iterations).filter((it) => it.judge);
  if (judged.length === 0) return null;
  const disagreements = judged.filter((it) => judgeDisagrees(it.passed, it.judge)).length;
  const errors = judged.filter((it) => it.judge?.verdict === 'error').length;
  return (
    <Text>
      LLM judge: {judged.length} verdicts ·{' '}
      <Text color={disagreements > 0 ? 'magenta' : undefined}>{disagreements} disagree with the tool-based result</Text>
      {errors > 0 && <Text color="yellow"> · {errors} judge errors</Text>}
    </Text>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
