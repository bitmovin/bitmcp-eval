import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const headerSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

/** Must stay in sync with `AgentKind` in agent.ts. */
const agentKindSchema = z.enum(['claude', 'codex']);

const configSchema = z.object({
  /**
   * Optional dotenv file loaded before `${VAR}` interpolation. Defaults to a
   * `.env` next to the config file, when one exists. Never overrides variables
   * already present in the environment.
   */
  envFile: z.string().min(1).optional(),
  mcp: z.object({
    /** URL of the MCP server under test (StreamableHTTP endpoint). */
    url: z.url(),
    /** Extra headers injected into every request towards the MCP server, e.g. API keys. */
    headers: z.array(headerSchema).default([]),
    /**
     * OAuth is auto-detected (a 401 challenge from the server triggers a login).
     * This block is only needed as a fallback for servers WITHOUT dynamic client
     * registration, to supply a manually-registered client's credentials.
     */
    oauth: z
      .object({
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        /** Loopback port for the OAuth redirect URI; must match the registered client. */
        redirectPort: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  }),
  testcases: z.object({
    /** Where test cases are stored. Only `filesystem` is implemented; `s3` and `git` are planned. */
    source: z.literal('filesystem').default('filesystem'),
    /** Directory containing `*.yaml` test case files. Relative paths resolve against the config file. */
    path: z.string().min(1),
  }),
  run: z
    .object({
      /** How often each test case is executed, to measure the spread in agent behavior. */
      iterations: z.number().int().min(1).max(100).default(3),
      /** Single chat agent — legacy alias for `agents: [<agent>]`. */
      agent: agentKindSchema.optional(),
      /** Chat agents to evaluate; the whole test suite runs once per agent. */
      agents: z.array(agentKindSchema).min(1).optional(),
      /** Hard timeout for a single agent invocation. */
      timeoutSeconds: z.number().int().min(1).default(300),
    })
    .refine((run) => !(run.agent && run.agents), {
      message: 'Use either run.agent or run.agents, not both',
    })
    .transform(({ agent, agents, ...rest }) => ({
      ...rest,
      agents: [...new Set(agents ?? (agent ? [agent] : ['claude' as const]))],
    }))
    .default({ iterations: 3, timeoutSeconds: 300, agents: ['claude'] }),
  report: z
    .object({
      /** Directory the HTML report is written to. Relative paths resolve against the config file. */
      outDir: z.string().min(1).default('./reports'),
    })
    .default({ outDir: './reports' }),
});

export type EvalConfig = z.infer<typeof configSchema>;
export type McpHeader = z.infer<typeof headerSchema>;

/**
 * Loads and validates an eval config from a YAML file.
 *
 * - `${VAR}` placeholders in header values are substituted from the environment,
 *   so secrets never need to live in the config file.
 * - `~` and relative paths are resolved (relative to the config file's directory).
 */
export function loadConfig(path: string): EvalConfig {
  const absPath = resolve(expandHome(path));
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    throw new Error(`Config file not found at ${absPath}`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new Error(`Config file at ${absPath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Config file at ${absPath} is invalid:\n${z.prettifyError(parsed.error)}`);
  }

  const config = parsed.data;
  const baseDir = dirname(absPath);
  config.testcases.path = resolvePath(config.testcases.path, baseDir);
  config.report.outDir = resolvePath(config.report.outDir, baseDir);

  if (config.envFile !== undefined) {
    config.envFile = resolvePath(config.envFile, baseDir);
    if (!existsSync(config.envFile)) {
      throw new Error(`envFile referenced in config not found: ${config.envFile}`);
    }
    loadEnvFile(config.envFile);
  } else {
    const defaultEnvFile = resolve(baseDir, '.env');
    if (existsSync(defaultEnvFile)) {
      config.envFile = defaultEnvFile;
      loadEnvFile(defaultEnvFile);
    }
  }

  config.mcp.headers = config.mcp.headers.map((h) => ({ name: h.name, value: interpolateEnv(h.value) }));
  if (config.mcp.oauth) {
    const { clientId, clientSecret } = config.mcp.oauth;
    if (clientId) config.mcp.oauth.clientId = interpolateEnv(clientId);
    if (clientSecret) config.mcp.oauth.clientSecret = interpolateEnv(clientSecret);
  }
  return config;
}

/**
 * Minimal dotenv loader: `KEY=value` lines, `#` comments, optional `export `
 * prefix and surrounding quotes. Variables already present in the environment
 * are left untouched, so the shell always wins.
 */
export function loadEnvFile(path: string): void {
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

function resolvePath(p: string, baseDir: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

/** Replaces `${VAR}` with `process.env.VAR`; throws when the variable is not set. */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Environment variable "${name}" referenced in config is not set`);
    }
    return v;
  });
}
