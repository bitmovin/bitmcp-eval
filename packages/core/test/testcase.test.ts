import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadTestCases } from '../src/testcase.js';

describe('loadTestCases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bitmcp-eval-cases-'));
  });

  it('loads yaml files in deterministic order and defaults the name to the file name', async () => {
    await writeFile(join(dir, 'b-case.yaml'), 'prompt: second\nexpectedTools: [beta]\n');
    await writeFile(join(dir, 'a-case.yaml'), 'name: named case\nprompt: first\nexpectedTools: [alpha]\n');
    await writeFile(join(dir, 'notes.txt'), 'ignored');

    const cases = await loadTestCases(dir);
    expect(cases.map((c) => c.name)).toEqual(['named case', 'b-case']);
    expect(cases[0]).toMatchObject({ prompt: 'first', expectedTools: ['alpha'], file: join(dir, 'a-case.yaml') });
  });

  it('rejects a test case without a prompt, naming the offending file', async () => {
    await writeFile(join(dir, 'broken.yaml'), 'expectedTools: [x]\n');
    await expect(loadTestCases(dir)).rejects.toThrow(/broken\.yaml/);
  });

  it('rejects invalid YAML, naming the offending file', async () => {
    await writeFile(join(dir, 'invalid.yml'), 'prompt: "unterminated\n');
    await expect(loadTestCases(dir)).rejects.toThrow(/invalid\.yml/);
  });

  it('throws when the directory contains no test cases', async () => {
    await expect(loadTestCases(dir)).rejects.toThrow(/No .yaml test case files/);
  });

  it('throws when the directory does not exist', async () => {
    await expect(loadTestCases(join(dir, 'missing'))).rejects.toThrow(/not found/);
  });
});
