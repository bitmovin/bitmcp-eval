import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, judgeDisagrees, judgeIteration, parseVerdict, type JudgeConfig } from '../src/judge.js';
import type { IterationResult } from '../src/runner.js';
import type { TestCase } from '../src/testcase.js';

const TEST_CASE: TestCase = {
  name: 'funnel',
  prompt: 'Show me the ad completion funnel for last week.',
  expectedTools: ['queryTotal', 'queryTotal', 'queryTotal'],
  answers: [],
  expectedOutcome: 'Four rates in descending order: quartile_1 >= midpoint >= quartile_3 >= completions.',
  file: '/t/funnel.yaml',
};

const ITERATION: IterationResult = {
  iteration: 1,
  passed: false,
  validation: {
    passed: false,
    expectations: [{ name: 'queryTotal', expected: 3, actual: 1, failed: 0, satisfied: false }],
    unexpectedTools: [],
  },
  toolCalls: [
    {
      id: 1,
      name: 'queryTotal',
      args: { metric: ['ad_quartile_1', 'ad_midpoint', 'ad_quartile_3', 'ad_completions'] },
      ok: true,
      result: { content: [{ type: 'text', text: '24413, 12361, 5960, 2921' }] },
      startedAt: 0,
      durationMs: 42,
    },
  ],
  escapes: [],
  turns: [
    { message: 'Show me the ad completion funnel for last week.', response: 'Funnel: 24413 → 12361 → 5960 → 2921.' },
  ],
  agentResponse: 'Funnel: 24413 → 12361 → 5960 → 2921.',
  durationMs: 9000,
};

const CONFIG: JudgeConfig = {
  provider: 'openai-compatible',
  baseUrl: 'http://judge.local/v1',
  model: 'test-model',
  timeoutSeconds: 30,
};

function fakeJudgeEndpoint(reply: string | number) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body!.toString()) });
    if (typeof reply === 'number') {
      return { ok: false, status: reply, text: async () => 'boom', json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
      text: async () => reply,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('buildJudgePrompt', () => {
  it('includes the request, rubric, mechanical result, tool calls, and conversation', () => {
    const prompt = buildJudgePrompt(TEST_CASE, ITERATION);
    expect(prompt).toContain('Show me the ad completion funnel');
    expect(prompt).toContain('Expected outcome');
    expect(prompt).toContain('descending order');
    expect(prompt).toContain('Result: failed');
    expect(prompt).toContain('queryTotal (1/3)');
    expect(prompt).toContain('ad_quartile_1');
    expect(prompt).toContain('agent: Funnel: 24413');
  });
});

describe('parseVerdict', () => {
  it('parses a plain JSON verdict', () => {
    expect(parseVerdict('{"verdict":"pass","reasoning":"Batched call answered fully."}')).toEqual({
      verdict: 'pass',
      reasoning: 'Batched call answered fully.',
    });
  });

  it('tolerates code fences and prose around the JSON', () => {
    const out = parseVerdict('Sure! Here is my judgement:\n```json\n{"verdict": "fail", "reasoning": "No data."}\n```');
    expect(out.verdict).toBe('fail');
  });

  it('returns error verdict for garbage output', () => {
    expect(parseVerdict('I think it went well overall.').verdict).toBe('error');
    expect(parseVerdict('{"verdict":"excellent"}').verdict).toBe('error');
  });
});

describe('judgeIteration', () => {
  it('calls the chat-completions endpoint and returns the parsed verdict', async () => {
    const { impl, calls } = fakeJudgeEndpoint(
      '{"verdict":"pass","reasoning":"One batched queryTotal answered the funnel."}',
    );
    const result = await judgeIteration(CONFIG, TEST_CASE, ITERATION, impl);
    expect(result).toEqual({
      verdict: 'pass',
      reasoning: 'One batched queryTotal answered the funnel.',
      model: 'test-model',
    });
    expect(calls[0].url).toBe('http://judge.local/v1/chat/completions');
    const body = calls[0].body as { model: string; temperature: number; messages: Array<{ role: string }> };
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('sends the api key as a bearer when configured', async () => {
    const seen: string[] = [];
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      seen.push((init!.headers as Record<string, string>)['authorization'] ?? '(none)');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","reasoning":"x"}' } }] }),
      } as Response;
    }) as unknown as typeof fetch;
    await judgeIteration({ ...CONFIG, apiKey: 'sk-123' }, TEST_CASE, ITERATION, impl);
    expect(seen).toEqual(['Bearer sk-123']);
  });

  it('never throws: endpoint errors become an error verdict', async () => {
    const { impl } = fakeJudgeEndpoint(503);
    const result = await judgeIteration(CONFIG, TEST_CASE, ITERATION, impl);
    expect(result.verdict).toBe('error');
    expect(result.reasoning).toContain('503');
  });

  it('never throws: network failure becomes an error verdict', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await judgeIteration(CONFIG, TEST_CASE, ITERATION, impl);
    expect(result.verdict).toBe('error');
    expect(result.reasoning).toContain('ECONNREFUSED');
  });
});

describe('judgeDisagrees', () => {
  it('flags only real contradictions', () => {
    expect(judgeDisagrees(false, { verdict: 'pass', reasoning: '' })).toBe(true);
    expect(judgeDisagrees(true, { verdict: 'fail', reasoning: '' })).toBe(true);
    expect(judgeDisagrees(true, { verdict: 'pass', reasoning: '' })).toBe(false);
    expect(judgeDisagrees(false, { verdict: 'fail', reasoning: '' })).toBe(false);
    expect(judgeDisagrees(false, { verdict: 'uncertain', reasoning: '' })).toBe(false);
    expect(judgeDisagrees(false, { verdict: 'error', reasoning: '' })).toBe(false);
    expect(judgeDisagrees(false, undefined)).toBe(false);
  });
});
