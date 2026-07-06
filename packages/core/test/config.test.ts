import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interpolateEnv, loadConfig } from '../src/config.js';

async function writeConfig(dir: string, yaml: string): Promise<string> {
  const path = join(dir, 'eval.yaml');
  await writeFile(path, yaml, 'utf8');
  return path;
}

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bitmcp-eval-config-'));
  });

  afterEach(() => {
    delete process.env.BITMCP_EVAL_TEST_SECRET;
    delete process.env.BITMCP_EVAL_TEST_FROM_FILE;
  });

  it('loads a minimal config and applies defaults', async () => {
    const path = await writeConfig(
      dir,
      `mcp:
  url: http://127.0.0.1:3210/mcp
testcases:
  path: ./testcases
`,
    );
    const config = loadConfig(path);
    expect(config.mcp.url).toBe('http://127.0.0.1:3210/mcp');
    expect(config.mcp.headers).toEqual([]);
    expect(config.testcases.source).toBe('filesystem');
    expect(config.run).toEqual({ iterations: 3, agent: 'claude', timeoutSeconds: 300 });
  });

  it('resolves relative paths against the config file directory', async () => {
    const path = await writeConfig(
      dir,
      `mcp:
  url: http://127.0.0.1:3210/mcp
testcases:
  path: ./cases
report:
  outDir: ./out
`,
    );
    const config = loadConfig(path);
    expect(config.testcases.path).toBe(resolve(dir, 'cases'));
    expect(config.report.outDir).toBe(resolve(dir, 'out'));
  });

  it('interpolates environment variables in header values', async () => {
    process.env.BITMCP_EVAL_TEST_SECRET = 's3cret';
    const path = await writeConfig(
      dir,
      `mcp:
  url: http://127.0.0.1:3210/mcp
  headers:
    - name: x-api-key
      value: \${BITMCP_EVAL_TEST_SECRET}
testcases:
  path: ./testcases
`,
    );
    const config = loadConfig(path);
    expect(config.mcp.headers).toEqual([{ name: 'x-api-key', value: 's3cret' }]);
  });

  it('throws a helpful error when a referenced env variable is missing', async () => {
    const path = await writeConfig(
      dir,
      `mcp:
  url: http://127.0.0.1:3210/mcp
  headers:
    - name: x-api-key
      value: \${BITMCP_EVAL_TEST_SECRET}
testcases:
  path: ./testcases
`,
    );
    expect(() => loadConfig(path)).toThrow(/BITMCP_EVAL_TEST_SECRET/);
  });

  it('rejects an invalid mcp url', async () => {
    const path = await writeConfig(
      dir,
      `mcp:
  url: not-a-url
testcases:
  path: ./testcases
`,
    );
    expect(() => loadConfig(path)).toThrow(/invalid/i);
  });

  it('throws when the config file does not exist', () => {
    expect(() => loadConfig(join(dir, 'nope.yaml'))).toThrow(/not found/);
  });

  it('auto-loads a .env file sitting next to the config file', async () => {
    await writeFile(join(dir, '.env'), '# comment\nexport BITMCP_EVAL_TEST_FROM_FILE="from-file"\n');
    const path = await writeConfig(
      dir,
      `mcp:
  url: http://127.0.0.1:3210/mcp
  headers:
    - name: x-api-key
      value: \${BITMCP_EVAL_TEST_FROM_FILE}
testcases:
  path: ./testcases
`,
    );
    const config = loadConfig(path);
    expect(config.envFile).toBe(join(dir, '.env'));
    expect(config.mcp.headers).toEqual([{ name: 'x-api-key', value: 'from-file' }]);
  });

  it('loads an explicit envFile but lets the shell environment win', async () => {
    process.env.BITMCP_EVAL_TEST_SECRET = 'from-shell';
    await writeFile(join(dir, 'custom.env'), 'BITMCP_EVAL_TEST_SECRET=from-file\n');
    const path = await writeConfig(
      dir,
      `envFile: ./custom.env
mcp:
  url: http://127.0.0.1:3210/mcp
  headers:
    - name: x-api-key
      value: \${BITMCP_EVAL_TEST_SECRET}
testcases:
  path: ./testcases
`,
    );
    const config = loadConfig(path);
    expect(config.mcp.headers).toEqual([{ name: 'x-api-key', value: 'from-shell' }]);
  });

  it('throws when an explicitly configured envFile is missing', async () => {
    const path = await writeConfig(
      dir,
      `envFile: ./missing.env
mcp:
  url: http://127.0.0.1:3210/mcp
testcases:
  path: ./testcases
`,
    );
    expect(() => loadConfig(path)).toThrow(/envFile referenced in config not found/);
  });
});

describe('interpolateEnv', () => {
  it('leaves strings without placeholders untouched', () => {
    expect(interpolateEnv('plain-value')).toBe('plain-value');
  });
});
