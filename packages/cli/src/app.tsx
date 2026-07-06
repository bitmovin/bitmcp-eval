import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import {
  createAgent,
  loadConfig,
  loadTestCases,
  writeHtmlReport,
  EvalRunner,
  type EvalConfig,
  type EvalRunReport,
  type TestCase,
  type TestCaseResult,
} from '@bitmcp-eval/core';
import { Header, IterationMarks, ProgressBar, Spinner } from './components.js';
import ConfigSummary from './config_summary.js';

type Phase = 'loading' | 'running' | 'done' | 'error';

interface CurrentIteration {
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
}

export default function App({ configPath, iterationsOverride }: AppProps) {
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
  const started = useRef(false);
  // Report writes go to the same file; chain them so snapshots never interleave.
  const reportWrites = useRef<Promise<unknown>>(Promise.resolve());

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
      setPhase('running');

      const runner = new EvalRunner({
        config: cfg,
        testCases: cases,
        agent: createAgent(cfg.run.agent),
        events: {
          onProxyStarted: (url) => setProxyUrl(url),
          onTestCaseStart: (testCase, index, total) =>
            setCurrent({
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
            reportWrites.current = reportWrites.current
              .then(() => writeHtmlReport(snapshot, cfg.report.outDir))
              .then((path) => setLiveReportPath(path))
              .catch(() => undefined); // a failed snapshot write never kills the run
          },
        },
      });

      const runReport = await runner.run();
      await reportWrites.current; // let the last live snapshot land before the final write
      const htmlPath = await writeHtmlReport(runReport, cfg.report.outDir);
      setCurrent(null);
      setReport({ report: runReport, htmlPath });
      setPhase('done');
    })().catch((err: unknown) => {
      setError(err instanceof Error ? err : new Error(String(err)));
      setPhase('error');
    });
  }, [configPath, iterationsOverride]);

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
  const iterationsTotal = testCases.length * (config?.run.iterations ?? 1);

  return (
    <Box flexDirection="column">
      <Static items={completed}>
        {(result) => <CompletedTestCaseRow key={result.testCase.file} result={result} />}
      </Static>

      <Header title="bitmcp-eval — MCP evaluation run" />

      {config ? <ConfigSummary config={config} /> : <Spinner label={`Loading config from ${configPath}…`} />}

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

function CompletedTestCaseRow({ result }: { result: TestCaseResult }) {
  const allPassed = result.iterations.every((it) => it.passed);
  return (
    <Text>
      <Text color={allPassed ? 'green' : 'red'}>{allPassed ? '✓' : '✗'}</Text> {result.testCase.name}{' '}
      <IterationMarks passes={result.iterations.map((it) => it.passed)} />
      <Text dimColor>
        {' '}
        ({result.iterations.filter((it) => it.passed).length}/{result.iterations.length} passed)
      </Text>
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
          {totals.testCases} test cases · {totals.iterations} iterations ·{' '}
          <Text color="green">{totals.passedIterations} passed</Text> ·{' '}
          <Text color={totals.failedIterations > 0 ? 'red' : undefined}>{totals.failedIterations} failed</Text> ·{' '}
          <Text bold color={passRate === 100 ? 'green' : passRate >= 50 ? 'yellow' : 'red'}>
            {passRate}% pass rate
          </Text>
        </Text>
        <Text>
          Report: <Text color="blue">file://{htmlPath}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
