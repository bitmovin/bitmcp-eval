import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { execAgentCli, parseClaudeJsonOutput } from '../src/agent.js';

describe('execAgentCli', () => {
  const cwd = tmpdir();

  it('closes stdin immediately so CLIs never wait for piped input', async () => {
    // Blocks until stdin reaches EOF — exactly how claude (3s stall + stderr
    // warning) and codex (hang until timeout) behave on an open stdin pipe.
    const script = 'process.stdin.resume(); process.stdin.on("end", () => console.log("stdin-eof"));';
    const stdout = await execAgentCli(process.execPath, ['-e', script], { cwd, timeoutMs: 5000 });
    expect(stdout.trim()).toBe('stdin-eof');
  });

  it('kills the child when timeoutMs elapses', async () => {
    const script = 'setTimeout(() => {}, 60000);';
    await expect(execAgentCli(process.execPath, ['-e', script], { cwd, timeoutMs: 100 })).rejects.toThrow();
  });

  it('surfaces stderr on non-zero exit for AgentInvocationError to pick up', async () => {
    const script = 'process.stderr.write("boom detail"); process.exit(1);';
    await expect(execAgentCli(process.execPath, ['-e', script], { cwd })).rejects.toMatchObject({
      stderr: expect.stringContaining('boom detail'),
    });
  });
});

describe('parseClaudeJsonOutput', () => {
  it('extracts result text and session id from claude --output-format json', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The weather in Vienna is sunny.',
      session_id: 'sess-123',
    });
    expect(parseClaudeJsonOutput(stdout)).toEqual({
      text: 'The weather in Vienna is sunny.',
      isError: false,
      sessionId: 'sess-123',
    });
  });

  it('flags agent-side errors', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Execution error' });
    expect(parseClaudeJsonOutput(stdout)).toEqual({ text: 'Execution error', isError: true, sessionId: undefined });
  });

  it('falls back to raw output when stdout is not JSON', () => {
    expect(parseClaudeJsonOutput('plain text answer\n')).toEqual({ text: 'plain text answer', isError: false });
  });
});
