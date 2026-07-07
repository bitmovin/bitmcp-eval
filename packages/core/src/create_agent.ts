import { ClaudeCodeAgent, type Agent, type AgentKind } from './agent.js';
import { CodexExecAgent } from './codex_agent.js';

export function createAgent(kind: AgentKind): Agent {
  switch (kind) {
    case 'claude':
      return new ClaudeCodeAgent();
    case 'codex':
      return new CodexExecAgent();
  }
}
