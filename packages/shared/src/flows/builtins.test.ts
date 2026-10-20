import { describe, it, expect } from 'vitest';
import { FLOW_BUILTIN_STEPS, FLOW_LATER_BUILTINS, isFlowBuiltin } from './builtins';

describe('flow builtins', () => {
  it('wait bounds minutes', () => {
    const s = FLOW_BUILTIN_STEPS.wait.inputSchema;
    expect(s.safeParse({ minutes: 5 }).success).toBe(true);
    expect(s.safeParse({ minutes: 1441 }).success).toBe(false);
    expect(s.safeParse({ minutes: 0 }).success).toBe(false);
    expect(s.safeParse({ minutes: 1.5 }).success).toBe(false);
    expect(s.safeParse({ minutes: 1, x: 1 }).success).toBe(false);
  });
  it('set requires 1..20 named values', () => {
    const s = FLOW_BUILTIN_STEPS.set.inputSchema;
    expect(s.safeParse({ values: { a: '{{x}}' } }).success).toBe(true);
    expect(s.safeParse({ values: {} }).success).toBe(false);
    expect(s.safeParse({ values: { '1bad': 1 } }).success).toBe(false);
    expect(s.safeParse({ values: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }).success).toBe(false);
  });
  it('tiers and guards', () => {
    expect(FLOW_BUILTIN_STEPS.wait.tier).toBe(1);
    expect(FLOW_BUILTIN_STEPS.set.tier).toBe(1);
    expect(isFlowBuiltin('wait')).toBe(true);
    expect(isFlowBuiltin('notify')).toBe(false);
    expect(isFlowBuiltin('toString')).toBe(false);
    expect([...FLOW_LATER_BUILTINS]).toEqual(['notify', 'ai', 'http_request']);
    for (const n of [...Object.keys(FLOW_BUILTIN_STEPS), ...FLOW_LATER_BUILTINS]) expect(n).not.toContain('__');
  });
});
