import { describe, expect, it } from 'vitest';
import { validateToolCalls, type CalledTool } from '../src/validate.js';

const ok = (...names: string[]): CalledTool[] => names.map((name) => ({ name, ok: true }));
const failed = (...names: string[]): CalledTool[] => names.map((name) => ({ name, ok: false }));

describe('validateToolCalls', () => {
  it('passes when every expected tool was called successfully', () => {
    const result = validateToolCalls(['query', 'queryTotal'], ok('query', 'queryTotal'));
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual([]);
  });

  it('fails when an expected tool was not called', () => {
    const result = validateToolCalls(['query', 'queryTotal'], ok('query'));
    expect(result.passed).toBe(false);
    expect(result.expectations).toContainEqual({
      name: 'queryTotal',
      expected: 1,
      actual: 0,
      failed: 0,
      satisfied: false,
    });
  });

  it('does NOT count failed calls towards expectations', () => {
    // Real-world regression: peekAllLicenses 401'd and queryTotal was rejected
    // with "Invalid uuid" — both wrapped as MCP isError results — yet the
    // iteration passed because only call *presence* was checked.
    const result = validateToolCalls(
      ['peekAllLicenses', 'queryTotal'],
      [...failed('peekAllLicenses', 'queryTotal'), ...ok('searchMetrics')],
    );
    expect(result.passed).toBe(false);
    expect(result.expectations).toEqual([
      { name: 'peekAllLicenses', expected: 1, actual: 0, failed: 1, satisfied: false },
      { name: 'queryTotal', expected: 1, actual: 0, failed: 1, satisfied: false },
    ]);
  });

  it('a failed call followed by a successful retry passes', () => {
    const result = validateToolCalls(['queryTotal'], [...failed('queryTotal'), ...ok('queryTotal')]);
    expect(result.passed).toBe(true);
    expect(result.expectations).toEqual([{ name: 'queryTotal', expected: 1, actual: 1, failed: 1, satisfied: true }]);
  });

  it('treats duplicated names as "at least N successful calls"', () => {
    expect(validateToolCalls(['query', 'query'], ok('query')).passed).toBe(false);
    expect(validateToolCalls(['query', 'query'], ok('query', 'query')).passed).toBe(true);
    expect(validateToolCalls(['query', 'query'], ok('query', 'query', 'query')).passed).toBe(true);
    expect(validateToolCalls(['query', 'query'], [...ok('query'), ...failed('query')]).passed).toBe(false);
  });

  it('allows extra successful calls of expected tools', () => {
    const result = validateToolCalls(['query'], ok('query', 'query', 'query'));
    expect(result.passed).toBe(true);
    expect(result.expectations).toEqual([{ name: 'query', expected: 1, actual: 3, failed: 0, satisfied: true }]);
  });

  it('reports unlisted tools without failing the run', () => {
    const result = validateToolCalls(['query'], ok('query', 'listFilters'));
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual(['listFilters']);
  });

  it('passes trivially with no expectations', () => {
    const result = validateToolCalls([], ok('anything'));
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual(['anything']);
  });
});
