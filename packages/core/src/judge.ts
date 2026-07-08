import type { IterationResult } from './runner.js';
import type { TestCase } from './testcase.js';

/** Configuration of the optional LLM judge (the `judge` block in eval.yaml). */
export interface JudgeConfig {
  /** Any OpenAI-compatible chat-completions endpoint: ollama, OpenAI, Anthropic compat, vLLM, … */
  provider: 'openai-compatible';
  /** e.g. http://127.0.0.1:11434/v1 (ollama) or https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutSeconds: number;
}

/**
 * The judge's independent opinion on one iteration. It never overrides the
 * mechanical tool-validation result — it is rendered next to it, and the
 * interesting cases are exactly where the two disagree.
 */
export interface JudgeResult {
  /** `error` = the judge itself failed (endpoint down, bad output); reasoning holds the message. */
  verdict: 'pass' | 'fail' | 'uncertain' | 'error';
  reasoning: string;
  model?: string;
}

/** True when the judge reached a verdict that contradicts the mechanical result. */
export function judgeDisagrees(mechanicalPassed: boolean, judge: JudgeResult | undefined): boolean {
  if (!judge) return false;
  return (judge.verdict === 'pass' && !mechanicalPassed) || (judge.verdict === 'fail' && mechanicalPassed);
}

const MAX_FIELD = 600;

function clip(value: unknown, max = MAX_FIELD): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Builds the judge prompt from the test case and the iteration's evidence.
 * Exported for tests.
 */
export function buildJudgePrompt(testCase: TestCase, iteration: IterationResult): string {
  const lines: string[] = [];

  lines.push('## User request');
  lines.push(testCase.prompt);

  if (testCase.expectedOutcome) {
    lines.push('', '## Expected outcome (rubric from the product spec)');
    lines.push(testCase.expectedOutcome);
  }

  lines.push('', '## Mechanical validation (tool-call based, for reference)');
  lines.push(`Expected tools: ${testCase.expectedTools.join(', ') || '(none)'}`);
  lines.push(`Result: ${iteration.passed ? 'passed' : 'failed'}`);
  const missing = iteration.validation.expectations.filter((e) => !e.satisfied);
  if (missing.length) {
    lines.push(`Unmet expectations: ${missing.map((e) => `${e.name} (${e.actual}/${e.expected})`).join(', ')}`);
  }

  lines.push('', '## Recorded tool calls');
  if (iteration.toolCalls.length === 0) lines.push('(none)');
  for (const call of iteration.toolCalls) {
    lines.push(`- ${call.name} [${call.ok ? 'ok' : 'FAILED'}] args=${clip(call.args, 300)}`);
    if (call.result !== undefined) lines.push(`  result: ${clip(call.result)}`);
  }

  lines.push('', '## Conversation');
  for (const turn of iteration.turns) {
    lines.push(`user: ${clip(turn.message, 400)}`);
    lines.push(`agent: ${clip(turn.response ?? '(no response)', 1200)}`);
  }
  if (iteration.error) {
    lines.push('', `## Harness error`, clip(iteration.error, 400));
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are an impartial judge for evaluations of MCP-server tool usage by LLM agents.
Given a user request, the tools the agent called (with arguments and results), and the conversation, decide whether the agent ANSWERED THE USER'S REQUEST correctly and completely, based on actual tool data rather than fabrication.
The mechanical validation only counts tool calls; you judge the semantic outcome. It is fine to disagree with it in either direction — e.g. the agent may have satisfied the request with a single batched call where two were expected, or it may have called every expected tool yet given a wrong or evasive answer.
If an "Expected outcome" rubric is provided, check the answer against it.
Respond with ONLY a JSON object: {"verdict": "pass" | "fail" | "uncertain", "reasoning": "<2-4 concise sentences>"}.`;

/**
 * Asks the configured LLM for a verdict on one iteration. Never throws — any
 * failure (endpoint down, malformed output) comes back as verdict "error" so
 * a broken judge annotates the run instead of breaking it.
 */
export async function judgeIteration(
  config: JudgeConfig,
  testCase: TestCase,
  iteration: IterationResult,
  fetchImpl: typeof fetch = fetch,
): Promise<JudgeResult> {
  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildJudgePrompt(testCase, iteration) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    });
    if (!res.ok) {
      return { verdict: 'error', reasoning: `Judge endpoint returned ${res.status}: ${clip(await res.text(), 200)}` };
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return { verdict: 'error', reasoning: 'Judge returned no content' };
    return { ...parseVerdict(content), model: config.model };
  } catch (err) {
    return { verdict: 'error', reasoning: `Judge unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Parses the model's JSON verdict, tolerating code fences, prose padding, and
 * verdict spelling variants ("Pass", "FAILED", …). Normalization matters: a
 * verdict that fell through to `error` would never be compared against the
 * mechanical result, silently losing its disagreement marker. Exported for tests.
 */
export function parseVerdict(content: string): Pick<JudgeResult, 'verdict' | 'reasoning'> {
  const jsonText = /\{[\s\S]*\}/.exec(content.replace(/```(?:json)?/g, ''))?.[0];
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { verdict?: string; reasoning?: string };
      const verdict = normalizeVerdict(parsed.verdict);
      if (verdict) {
        return { verdict, reasoning: clip(parsed.reasoning ?? '(no reasoning given)', 2000) };
      }
    } catch {
      /* fall through */
    }
  }
  return { verdict: 'error', reasoning: `Judge produced unparseable output: ${clip(content, 300)}` };
}

function normalizeVerdict(raw: unknown): 'pass' | 'fail' | 'uncertain' | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'pass' || v === 'passed' || v === 'passing') return 'pass';
  if (v === 'fail' || v === 'failed' || v === 'failing') return 'fail';
  if (v === 'uncertain' || v === 'unsure' || v === 'unknown' || v === 'inconclusive') return 'uncertain';
  return undefined;
}
