import { describe, expect, it } from 'vitest';
import { esc, renderHtmlReport } from '../src/report.js';
import type { EvalRunReport } from '../src/runner.js';

function sampleReport(): EvalRunReport {
  return {
    startedAt: '2026-07-06T10:00:00.000Z',
    finishedAt: '2026-07-06T10:05:00.000Z',
    mcpUrl: 'http://127.0.0.1:3210/mcp',
    agent: 'claude',
    iterationsPerTestCase: 2,
    results: [
      {
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
              expectations: [{ name: 'get_current_weather', expected: 1, actual: 1, satisfied: true }],
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
            turns: [{ message: 'What is the weather in Vienna?', response: 'It is sunny.' }],
            agentResponse: 'It is sunny.',
            durationMs: 9000,
          },
          {
            iteration: 2,
            passed: false,
            validation: {
              passed: false,
              expectations: [{ name: 'get_current_weather', expected: 1, actual: 0, satisfied: false }],
              unexpectedTools: ['list_supported_cities'],
            },
            toolCalls: [],
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
  };
}

describe('renderHtmlReport', () => {
  it('renders summary numbers, test case data, and the report is self-contained', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('50%'); // pass rate
    expect(html).toContain('What is the weather in Vienna?');
    expect(html).toContain('get_current_weather');
    expect(html).not.toMatch(/<script/); // no scripts at all — static and XSS-safe
    expect(html).toContain('&lt;script&gt;'); // the malicious name is escaped
  });

  it('shows missing tool expectations with counts', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('(0/1)');
  });

  it('renders the full conversation for multi-turn iterations', () => {
    const html = renderHtmlReport(sampleReport());
    expect(html).toContain('Conversation (2 turns)');
    expect(html).toContain('Which city do you mean exactly?');
    expect(html).toContain('Vienna, Austria');
  });
});

describe('esc', () => {
  it('escapes all HTML metacharacters', () => {
    expect(esc(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
