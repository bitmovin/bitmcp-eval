#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { createAuthSession, loadConfig } from '@bitmcp-eval/core';
import App from './app.js';

const cli = meow(
  `
  Usage
    $ bitmcp-eval [options]
    $ bitmcp-eval login [options]   Authorize an OAuth-protected MCP server and cache the token

  Options
    --config, -c      Path to the eval config YAML (default: ./eval.yaml)
    --iterations, -i  Override run.iterations from the config
    --debug           Log every proxied request's headers and tools to
                      <report.outDir>/bitmcp-eval-debug.log (contains secrets!)

  Examples
    $ bitmcp-eval --config examples/eval.yaml
    $ bitmcp-eval -c my-eval.yaml -i 5
    $ bitmcp-eval login -c my-eval.yaml
`,
  {
    importMeta: import.meta,
    flags: {
      config: { type: 'string', shortFlag: 'c', default: './eval.yaml' },
      iterations: { type: 'number', shortFlag: 'i' },
      debug: { type: 'boolean', default: false },
    },
  },
);

const configPath = resolveConfigPath(cli.flags.config);

if (cli.input[0] === 'login') {
  await runLogin(configPath);
} else {
  render(<App configPath={configPath} iterationsOverride={cli.flags.iterations} debug={cli.flags.debug} />);
}

/** Resolve `--config` against the invocation directory (`INIT_CWD` when a package manager sets it). */
function resolveConfigPath(configFlag: string): string {
  const expanded = configFlag.startsWith('~') ? configFlag.replace(/^~/, homedir()) : configFlag;
  return resolve(process.env.INIT_CWD ?? process.cwd(), expanded);
}

/** Explicit login: pre-warm the token cache before a (possibly headless) run. */
async function runLogin(configPath: string): Promise<void> {
  try {
    const config = loadConfig(configPath);
    const session = await createAuthSession({
      mcpUrl: config.mcp.url,
      config: config.mcp.oauth,
      interactive: true,
    });
    if (!session) {
      console.log(`${config.mcp.url} does not require OAuth — nothing to log in to.`);
      return;
    }
    await session.getAuthHeader(); // force a token to exist / be valid
    console.log('✅ Authorized. Token cached — future runs will use it automatically.');
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
