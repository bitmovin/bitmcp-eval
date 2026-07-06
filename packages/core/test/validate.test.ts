import { describe, expect, it } from 'vitest';
import { validateToolCalls } from '../src/validate.js';

describe('validateToolCalls', () => {
  it('passes when every expected tool was called', () => {
    const result = validateToolCalls(['query', 'queryTotal'], ['query', 'queryTotal']);
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual([]);
  });

  it('fails when an expected tool was not called', () => {
    const result = validateToolCalls(['query', 'queryTotal'], ['query']);
    expect(result.passed).toBe(false);
    expect(result.expectations).toContainEqual({ name: 'queryTotal', expected: 1, actual: 0, satisfied: false });
  });

  it('treats duplicated names as "at least N calls"', () => {
    expect(validateToolCalls(['query', 'query'], ['query']).passed).toBe(false);
    expect(validateToolCalls(['query', 'query'], ['query', 'query']).passed).toBe(true);
    expect(validateToolCalls(['query', 'query'], ['query', 'query', 'query']).passed).toBe(true);
  });

  it('allows extra calls of expected tools', () => {
    const result = validateToolCalls(['query'], ['query', 'query', 'query']);
    expect(result.passed).toBe(true);
    expect(result.expectations).toEqual([{ name: 'query', expected: 1, actual: 3, satisfied: true }]);
  });

  it('reports unlisted tools without failing the run', () => {
    const result = validateToolCalls(['query'], ['query', 'listFilters']);
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual(['listFilters']);
  });

  it('passes trivially with no expectations', () => {
    const result = validateToolCalls([], ['anything']);
    expect(result.passed).toBe(true);
    expect(result.unexpectedTools).toEqual(['anything']);
  });
});
