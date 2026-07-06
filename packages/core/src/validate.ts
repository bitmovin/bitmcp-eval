/** One expected tool and how often it was actually called. */
export interface ToolExpectation {
  name: string;
  /** Minimum number of calls expected (how often the name appears in `expectedTools`). */
  expected: number;
  /** Number of calls observed by the recording proxy. */
  actual: number;
  satisfied: boolean;
}

export interface ValidationResult {
  passed: boolean;
  expectations: ToolExpectation[];
  /** Tools that were called but not expected at all. Informational — they do not fail the iteration. */
  unexpectedTools: string[];
}

/**
 * Validates recorded tool calls against a test case's `expectedTools`.
 *
 * Semantics: listing a tool name N times means "expect at least N calls".
 * Extra calls of expected tools are fine; calls of unlisted tools are
 * reported but do not fail the run (agents legitimately explore).
 */
export function validateToolCalls(expectedTools: string[], calledTools: string[]): ValidationResult {
  const expectedCounts = countBy(expectedTools);
  const actualCounts = countBy(calledTools);

  const expectations: ToolExpectation[] = [...expectedCounts.entries()].map(([name, expected]) => {
    const actual = actualCounts.get(name) ?? 0;
    return { name, expected, actual, satisfied: actual >= expected };
  });

  const unexpectedTools = [...actualCounts.keys()].filter((name) => !expectedCounts.has(name));

  return {
    passed: expectations.every((e) => e.satisfied),
    expectations,
    unexpectedTools,
  };
}

function countBy(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}
