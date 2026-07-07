import { describe, expect, it } from 'vitest';
import { buildCodexExecArgs, parseCodexJsonl } from '../src/codex_agent.js';

describe('buildCodexExecArgs', () => {
  const URL = 'http://127.0.0.1:1234/mcp';

  it('starts a fresh session with exec and the MCP override', () => {
    const args = buildCodexExecArgs('hello', URL);
    expect(args.slice(0, 2)).toEqual(['exec', 'hello']);
    expect(args).toContain('--json');
    expect(args).toContain(`mcp_servers.mcp-under-test.url="${URL}"`);
  });

  it('resumes with the session id before the prompt', () => {
    const args = buildCodexExecArgs('the answer', URL, 'sess-1');
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'sess-1', 'the answer']);
  });

  it.each(['fresh', 'resume'] as const)('uses only flags that codex exec resume also accepts (%s)', (mode) => {
    // `codex exec resume` rejects flags like --color and -C with a hard error,
    // which silently broke every multi-turn iteration once (real regression).
    const RESUME_SUPPORTED = new Set([
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
    ]);
    const args = buildCodexExecArgs('m', URL, mode === 'resume' ? 'sess-1' : undefined);
    const flags = args.filter((a) => a.startsWith('-'));
    for (const flag of flags) {
      expect(RESUME_SUPPORTED, `flag ${flag} is not accepted by codex exec resume`).toContain(flag);
    }
  });
});

// Event shapes below are captured from a real `codex exec --json` run (codex-cli 0.142.5).
const THREAD = '{"type":"thread.started","thread_id":"019f3b15-02b1-7620-a35f-6abae4fcf709"}';

describe('parseCodexJsonl', () => {
  it('extracts the thread id and the last agent message', () => {
    const stdout = [
      THREAD,
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Calling the tool now."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"mcp-under-test","tool":"get_current_weather","status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"It is 24°C and sunny in Vienna."}}',
      '{"type":"turn.completed","usage":{"input_tokens":11754,"output_tokens":8}}',
    ].join('\n');

    expect(parseCodexJsonl(stdout)).toEqual({
      text: 'It is 24°C and sunny in Vienna.',
      isError: false,
      sessionId: '019f3b15-02b1-7620-a35f-6abae4fcf709',
      escapes: [],
    });
  });

  it('reports error events when no agent message was produced', () => {
    const stdout = [THREAD, '{"type":"error","message":"stream disconnected"}'].join('\n');
    expect(parseCodexJsonl(stdout)).toEqual({
      text: 'stream disconnected',
      isError: true,
      sessionId: '019f3b15-02b1-7620-a35f-6abae4fcf709',
      escapes: [],
    });
  });

  it('detects shell and web-search escapes from the MCP binding', () => {
    const stdout = [
      THREAD,
      '{"type":"item.completed","item":{"id":"item_0","type":"web_search","query":"weather: Vienna, Austria"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"curl -s wttr.in/Vienna?format=3"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"It is 22°C."}}',
    ].join('\n');

    expect(parseCodexJsonl(stdout)).toMatchObject({
      text: 'It is 22°C.',
      escapes: ['web search: weather: Vienna, Austria', 'shell: curl -s wttr.in/Vienna?format=3'],
    });
  });

  it('reports turn.failed when no agent message was produced', () => {
    const stdout = [THREAD, '{"type":"turn.failed","error":{"message":"model overloaded"}}'].join('\n');
    expect(parseCodexJsonl(stdout)).toMatchObject({ text: 'model overloaded', isError: true });
  });

  it('prefers the agent message over earlier transient errors', () => {
    const stdout = [
      THREAD,
      '{"type":"error","message":"retrying request"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done anyway"}}',
    ].join('\n');
    expect(parseCodexJsonl(stdout)).toMatchObject({ text: 'done anyway', isError: false });
  });

  it('skips non-JSON noise lines', () => {
    const stdout = [
      'Reading additional input from stdin...',
      THREAD,
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
    ].join('\n');
    expect(parseCodexJsonl(stdout)).toMatchObject({ text: 'hello', isError: false });
  });

  it('falls back to raw output for unparseable stdout', () => {
    expect(parseCodexJsonl('plain text\n')).toEqual({
      text: 'plain text',
      isError: false,
      sessionId: undefined,
      escapes: [],
    });
  });
});
