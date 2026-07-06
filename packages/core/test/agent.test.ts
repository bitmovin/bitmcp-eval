import { describe, expect, it } from 'vitest';
import { parseClaudeJsonOutput } from '../src/agent.js';

describe('parseClaudeJsonOutput', () => {
  it('extracts the result text from claude --output-format json', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The weather in Vienna is sunny.',
    });
    expect(parseClaudeJsonOutput(stdout)).toEqual({ text: 'The weather in Vienna is sunny.', isError: false });
  });

  it('flags agent-side errors', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Execution error' });
    expect(parseClaudeJsonOutput(stdout)).toEqual({ text: 'Execution error', isError: true });
  });

  it('falls back to raw output when stdout is not JSON', () => {
    expect(parseClaudeJsonOutput('plain text answer\n')).toEqual({ text: 'plain text answer', isError: false });
  });
});
