import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AgentInvocationError,
  MCP_SERVER_ALIAS,
  makeNeutralWorkDir,
  removeNeutralWorkDir,
  type Agent,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTurnResult,
} from './agent.js';

const execFileAsync = promisify(execFile);

/**
 * Steers codex towards the server under test. Unlike claude's
 * `--allowedTools`, codex offers no way to *enforce* this (its shell tool
 * cannot be disabled by config), so instructions are the strongest available
 * lever — see the caveats on {@link CodexExecAgent}.
 */
const CODEX_GUARDRAILS = `You are being evaluated on how you use the tools of the MCP server "${MCP_SERVER_ALIAS}".
Answer user questions exclusively with the MCP tools this server provides.
Never answer from your own knowledge, never run shell commands, and never fetch data from the network in any other way.
`;

/**
 * Runs conversations through the OpenAI Codex CLI (`codex exec`).
 *
 * Each turn is one headless invocation; follow-up turns resume the same
 * session via `codex exec resume <thread-id>`. The proxy URL is injected as
 * an MCP server through a `-c` config override.
 *
 * Caveats (state of codex-cli 0.142):
 * - `--dangerously-bypass-approvals-and-sandbox` is required: in exec mode
 *   every MCP tool call hits an interactive approval prompt that is
 *   auto-cancelled headlessly (openai/codex#16685, #24135). This also lifts
 *   the sandbox for shell commands the agent may run — only evaluate trusted
 *   test cases, or run the harness in a container.
 * - Unlike claude's `--strict-mcp-config` there is no isolation flag that
 *   keeps `-c` overrides working, so MCP servers from the user's own
 *   `~/.codex/config.toml` remain visible to the agent during the eval.
 */
export class CodexExecAgent implements Agent {
  readonly name = 'codex';

  createSession(mcpUrl: string, options?: AgentSessionOptions): AgentSession {
    return new CodexExecSession(mcpUrl, options);
  }
}

class CodexExecSession implements AgentSession {
  private sessionId?: string;
  /** Neutral cwd (with guardrail AGENTS.md) so the eval never inherits the caller's project context. */
  private readonly workDir: string;

  constructor(
    private readonly mcpUrl: string,
    private readonly options?: AgentSessionOptions,
  ) {
    this.workDir = makeNeutralWorkDir('codex');
    writeFileSync(join(this.workDir, 'AGENTS.md'), CODEX_GUARDRAILS);
  }

  close(): void {
    removeNeutralWorkDir(this.workDir);
  }

  async send(message: string): Promise<AgentTurnResult> {
    const args = ['exec'];
    if (this.sessionId !== undefined) {
      args.push('resume', this.sessionId);
    }
    args.push(
      message,
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      this.workDir,
      '-c',
      `mcp_servers.${MCP_SERVER_ALIAS}.url="${this.mcpUrl}"`,
      // Keep the eval clean: without this, codex happily answers via its
      // built-in web search instead of the MCP server under test.
      '-c',
      'web_search="disabled"',
    );

    let stdout: string;
    try {
      const invocation = execFileAsync('codex', args, {
        timeout: this.options?.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      // codex exec treats piped stdin as extra prompt input and blocks until
      // EOF — close it right away or every turn hangs until the timeout.
      invocation.child.stdin?.end();
      ({ stdout } = await invocation);
    } catch (err) {
      throw new AgentInvocationError('codex', err);
    }

    const parsed = parseCodexJsonl(stdout);
    this.sessionId = parsed.sessionId ?? this.sessionId;
    return { text: parsed.text, isError: parsed.isError };
  }
}

/**
 * Parses `codex exec --json` JSONL events: the thread id from
 * `thread.started`, the last `agent_message` as the turn's answer, and
 * `error` / `turn.failed` events as failures.
 */
export function parseCodexJsonl(stdout: string): AgentTurnResult & { sessionId?: string } {
  let sessionId: string | undefined;
  let lastMessage: string | undefined;
  let errorMessage: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: unknown };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
    } else if (event.type === 'item.completed') {
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        lastMessage = item.text;
      }
    } else if (event.type === 'error' && typeof event.message === 'string') {
      errorMessage = event.message;
    } else if (event.type === 'turn.failed') {
      errorMessage = event.error?.message ?? 'codex turn failed';
    }
  }

  if (lastMessage !== undefined) {
    return { text: lastMessage, isError: false, sessionId };
  }
  return { text: errorMessage ?? stdout.trim(), isError: errorMessage !== undefined, sessionId };
}
