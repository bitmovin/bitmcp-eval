import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The MCP server alias the agent sees; tool names arrive as `mcp__<alias>__<tool>`. */
export const MCP_SERVER_ALIAS = 'mcp-under-test';

export interface AgentRunOptions {
  /** Hard timeout for the agent invocation, in milliseconds. */
  timeoutMs?: number;
}

export interface AgentRunResult {
  /** The agent's final textual answer. */
  text: string;
  /** True when the agent itself reported an error result. */
  isError: boolean;
}

/** A chat agent that executes one prompt against the MCP server behind `mcpUrl`. */
export interface Agent {
  readonly name: string;
  run(prompt: string, mcpUrl: string, options?: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Runs prompts through the Claude Code CLI (`claude -p`).
 *
 * The proxy URL is injected as the only MCP server (`--strict-mcp-config`),
 * and only tools of that server are auto-allowed, so the agent can call the
 * server under test without any interactive permission prompts.
 */
export class ClaudeCodeAgent implements Agent {
  readonly name = 'claude';

  async run(prompt: string, mcpUrl: string, options?: AgentRunOptions): Promise<AgentRunResult> {
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER_ALIAS]: { type: 'http', url: mcpUrl },
      },
    };

    const args = [
      '-p',
      prompt,
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--allowedTools',
      `mcp__${MCP_SERVER_ALIAS}__*`,
      '--output-format',
      'json',
    ];

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('claude', args, {
        timeout: options?.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      throw new AgentInvocationError(this.name, err);
    }

    return parseClaudeJsonOutput(stdout);
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

/** Parses `claude --output-format json` output into the final result text. */
export function parseClaudeJsonOutput(stdout: string): AgentRunResult {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
      return { text: parsed.result, isError: parsed.is_error === true };
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
