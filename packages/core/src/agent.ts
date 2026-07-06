import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The MCP server alias the agent sees; tool names arrive as `mcp__<alias>__<tool>`. */
export const MCP_SERVER_ALIAS = 'mcp-under-test';

export interface AgentSessionOptions {
  /** Hard timeout per turn, in milliseconds. */
  timeoutMs?: number;
}

export interface AgentTurnResult {
  /** The agent's textual answer for this turn. */
  text: string;
  /** True when the agent itself reported an error result. */
  isError: boolean;
}

/**
 * One conversation with the agent. The first `send` starts it; further calls
 * continue it with full context, so the harness can answer clarifying
 * questions the agent asks.
 */
export interface AgentSession {
  send(message: string): Promise<AgentTurnResult>;
}

/** A chat agent that converses against the MCP server behind `mcpUrl`. */
export interface Agent {
  readonly name: string;
  createSession(mcpUrl: string, options?: AgentSessionOptions): AgentSession;
}

/**
 * Runs conversations through the Claude Code CLI.
 *
 * Each turn is one headless `claude -p` invocation; follow-up turns resume the
 * same session via `--resume <session-id>`. The proxy URL is injected as the
 * only MCP server (`--strict-mcp-config`), and only tools of that server are
 * auto-allowed, so no interactive permission prompts occur.
 */
export class ClaudeCodeAgent implements Agent {
  readonly name = 'claude';

  createSession(mcpUrl: string, options?: AgentSessionOptions): AgentSession {
    return new ClaudeCodeSession(mcpUrl, options);
  }
}

class ClaudeCodeSession implements AgentSession {
  private sessionId?: string;

  constructor(
    private readonly mcpUrl: string,
    private readonly options?: AgentSessionOptions,
  ) {}

  async send(message: string): Promise<AgentTurnResult> {
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER_ALIAS]: { type: 'http', url: this.mcpUrl },
      },
    };

    const args = [
      '-p',
      message,
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--allowedTools',
      `mcp__${MCP_SERVER_ALIAS}__*`,
      '--output-format',
      'json',
    ];
    if (this.sessionId !== undefined) {
      args.push('--resume', this.sessionId);
    }

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('claude', args, {
        timeout: this.options?.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      throw new AgentInvocationError('claude', err);
    }

    const parsed = parseClaudeJsonOutput(stdout);
    this.sessionId = parsed.sessionId ?? this.sessionId;
    return { text: parsed.text, isError: parsed.isError };
  }
}

/** Thrown when the agent process fails to run (missing binary, non-zero exit, timeout). */
export class AgentInvocationError extends Error {
  constructor(agentName: string, cause: unknown) {
    const detail =
      cause && typeof cause === 'object' && 'stderr' in cause && (cause as { stderr?: string }).stderr
        ? (cause as { stderr: string }).stderr.trim()
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(`Agent "${agentName}" failed: ${detail}`);
    this.name = 'AgentInvocationError';
  }
}

/** Parses `claude --output-format json` output into result text + session id. */
export function parseClaudeJsonOutput(stdout: string): AgentTurnResult & { sessionId?: string } {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
      return {
        text: parsed.result,
        isError: parsed.is_error === true,
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      };
    }
  } catch {
    /* fall through to raw output */
  }
  return { text: stdout.trim(), isError: false };
}

export function createAgent(kind: 'claude'): Agent {
  switch (kind) {
    case 'claude':
      return new ClaudeCodeAgent();
  }
}
