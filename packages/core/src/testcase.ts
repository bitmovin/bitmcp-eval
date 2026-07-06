import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const testCaseFileSchema = z.object({
  /** Human-readable name; defaults to the file name. */
  name: z.string().min(1).optional(),
  /** The prompt handed to the chat agent. */
  prompt: z.string().min(1),
  /**
   * Tool names the agent is expected to call. Listing a name N times means
   * "expect at least N calls" of that tool within one iteration.
   */
  expectedTools: z.array(z.string().min(1)),
  /**
   * Scripted user replies for when the agent ends a turn without having
   * satisfied the expectations — typically because it asked a clarifying
   * question. The harness sends them in order, one per extra turn, until the
   * expectations are met or the list is exhausted.
   */
  answers: z.array(z.string().min(1)).default([]),
});

export interface TestCase {
  name: string;
  prompt: string;
  expectedTools: string[];
  answers: string[];
  /** Absolute path of the file this test case was loaded from. */
  file: string;
}

/**
 * Loads all `*.yaml` / `*.yml` test cases from a directory (the `filesystem` provider).
 * Files are processed in lexicographic order so runs are deterministic.
 */
export async function loadTestCases(dir: string): Promise<TestCase[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`Test case directory not found: ${dir}`);
  }

  const files = entries.filter((f) => /\.ya?ml$/i.test(f)).sort();
  if (files.length === 0) {
    throw new Error(`No .yaml test case files found in ${dir}`);
  }

  const testCases: TestCase[] = [];
  for (const f of files) {
    const file = join(dir, f);
    const text = await readFile(file, 'utf8');

    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new Error(`Test case ${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parsed = testCaseFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Test case ${file} is invalid:\n${z.prettifyError(parsed.error)}`);
    }

    testCases.push({
      name: parsed.data.name ?? basename(f, extname(f)),
      prompt: parsed.data.prompt,
      expectedTools: parsed.data.expectedTools,
      answers: parsed.data.answers,
      file,
    });
  }

  return testCases;
}
