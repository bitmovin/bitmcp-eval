import { describe, expect, it } from 'vitest';
import { esc, renderHtmlReport } from '../src/report.js';
import type { EvalRunReport } from '../src/runner.js';

function sampleReport(): EvalRunReport {
  return {
    status: 'completed',
    startedAt: '2026-07-06T10:00:00.000Z',
    finishedAt: '2026-07-06T10:05:00.000Z',
    mcpUrl: 'http://127.0.0.1:3210/mcp',
    agents: ['claude'],
    iterationsPerTestCase: 2,
    plannedTestCases: 1,
    results: [
      {
        agent: 'claude',
        testCase: {
          name: 'weather <script>alert(1)</script>',
          prompt: 'What is the weather in Vienna?',
          expectedTools: ['get_current_weather'],
          answers: [],
          file: '/tmp/cases/weather.yaml',
        },
        iterations: [
          {
            iteration: 1,
            passed: true,
            validation: {
              passed: true,
              expectations: [{ name: 'get_current_weather', expected: 1, actual: 1, failed: 0, satisfied: true }],
              unexpectedTools: [],
            },
            toolCalls: [
              {
                id: 1,
                name: 'get_current_weather',
                args: { city: 'Vienna' },
                ok: true,
                startedAt: 0,
                durationMs: 42,
              },
            ],
            escapes: [],
            turns: [{ message: 'What is the weather in Vienna?', response: 'It is sunny.' }],
            agentResponse: 'It is sunny.',
            durationMs: 9000,
          },
          {
            iteration: 2,
            passed: false,
            validation: {
              passed: false,
              expectations: [{ name: 'get_current_weather', expected: 1, actual: 0, failed: 2, satisfied: false }],
              unexpectedTools: ['list_supported_cities'],
            },
            toolCalls: [],
            escapes: ['web search: current weather Vienna'],
            turns: [
              { message: 'What is the weather in Vienna?', response: 'Which city do you mean exactly?' },
              { message: 'Vienna, Austria', response: 'I could not find out.' },
            ],
            agentResponse: 'I could not find out.',
            durationMs: 4000,
          },
        ],
        passRate: 0.5,
      },
    ],
    totals: { testCases: 1, iterations: 2, passedIterations: 1, failedIterations: 1 },
    perAgent: [{ agent: 'claude', testCases: 1, iterations: 2, passedIterations: 1, failedIterations: 1 }],
  };
}

describe('renderHtmlReport', () => {
  it('renders summary numbers, test case data, and the report is self-contained', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('50%'); // pass rate
    expect(html).toContain('What is the weather in Vienna?');
    expect(html).toContain('get_current_weather');
    // XSS-safe: the only script is our own details-state helper; the malicious
    // test case name arrives escaped, never as markup.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain("var KEY = 'bitmcp-eval-details-'");
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('shows missing tool expectations with success and failure counts', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('(0/1, 2 failed)');
  });

  it('marks failed tool calls in the call chips', () => {
    const withFailedCall = sampleReport();
    withFailedCall.results[0].iterations[0].toolCalls[0].ok = false;
    const html = renderHtmlReport(withFailedCall);
    expect(html).toContain('class="tool error"');
  });

  it('renders the full conversation for multi-turn iterations', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('Conversation (2 turns)');
    expect(html).toContain('Which city do you mean exactly?');
    expect(html).toContain('Vienna, Austria');
  });

  it('marks running snapshots with a progress banner and auto-refresh', () => {
    const running = { ...sampleReport(), status: 'running' as const, plannedTestCases: 5 };
    const html = renderHtmlReport(running);
    expect(html).toContain('Run in progress');
    expect(html).toContain('1 of 5 test cases finished');
    expect(html).toContain('http-equiv="refresh"');
  });

  it('completed reports have no banner and no auto-refresh', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).not.toContain('Run in progress');
    expect(html).not.toContain('Run aborted');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('aborted reports show an abort banner and stop refreshing', () => {
    const aborted = { ...sampleReport(), status: 'aborted' as const, plannedTestCases: 7 };
    const html = renderHtmlReport(aborted);
    expect(html).toContain('Run aborted');
    expect(html).toContain('1 of 7 test cases were finished');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('renders an agent comparison table only for multi-agent runs', () => {
    expect(renderHtmlReport(sampleReport())).not.toContain('Agents compared');

    const multi: EvalRunReport = {
      ...sampleReport(),
      agents: ['claude', 'codex'],
      perAgent: [
        { agent: 'claude', testCases: 1, iterations: 2, passedIterations: 2, failedIterations: 0 },
        { agent: 'codex', testCases: 1, iterations: 2, passedIterations: 1, failedIterations: 1 },
      ],
    };
    const html = renderHtmlReport(multi);
    expect(html).toContain('Agents compared');
    expect(html).toContain('codex');
    expect(html).toContain('100%');
    expect(html).toContain('50%');
  });

  it('surfaces escapes from the MCP binding', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('Left the MCP binding (1×)');
    expect(html).toContain('web search: current weather Vienna');
  });

  it('details sections carry stable keys and the state-restore script', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('data-key="0-1-calls"'); // first test case, iteration 1, recorded calls
    expect(html).toContain('data-key="0-2-conv"'); // iteration 2, conversation
    expect(html).toContain('\'bitmcp-eval-details-\' + "2026-07-06T10:00:00.000Z"');
  });
});

describe('esc', () => {
  it('escapes all HTML metacharacters', () => {
    expect(esc(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
