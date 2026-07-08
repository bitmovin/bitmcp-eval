/** A recorded tool call, reduced to what validation needs. */
export interface CalledTool {
  name: string;
  /** False when the call failed (JSON-RPC error or an MCP result with isError). */
  ok: boolean;
}

/** One expected tool and how often it was actually called. */
export interface ToolExpectation {
  name: string;
  /** Minimum number of successful calls expected (how often the name appears in `expectedTools`). */
  expected: number;
  /** Number of successful calls observed by the recording proxy. */
  actual: number;
  /** Number of failed calls of this tool — never satisfies the expectation, shown for diagnosis. */
  failed: number;
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
 * Semantics: listing a tool name N times means "expect at least N successful
 * calls" — a call whose result is an error does not count. Extra calls of
 * expected tools are fine; calls of unlisted tools are reported but do not
 * fail the run (agents legitimately explore).
 */
export function validateToolCalls(expectedTools: string[], calls: CalledTool[]): ValidationResult {
  const expectedCounts = countBy(expectedTools);
  const successCounts = countBy(calls.filter((c) => c.ok).map((c) => c.name));
  const failureCounts = countBy(calls.filter((c) => !c.ok).map((c) => c.name));

  const expectations: ToolExpectation[] = [...expectedCounts.entries()].map(([name, expected]) => {
    const actual = successCounts.get(name) ?? 0;
    return { name, expected, actual, failed: failureCounts.get(name) ?? 0, satisfied: actual >= expected };
  });

  const unexpectedTools = [...new Set(calls.map((c) => c.name))].filter((name) => !expectedCounts.has(name));

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
