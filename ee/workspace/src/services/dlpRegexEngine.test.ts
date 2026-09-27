import { describe, it, expect } from 'vitest';
import { compileRe2, execAllRe2 } from './dlpRegexEngine';

describe('compileRe2', () => {
  it('compiles an ordinary pattern', () => {
    expect(compileRe2('\\d{3}-\\d{2}-\\d{4}').ok).toBe(true);
  });

  it('rejects a backreference', () => {
    expect(compileRe2('(a)\\1')).toEqual({ ok: false, reason: 'backreference_not_allowed' });
  });

  it('rejects a lookahead', () => {
    expect(compileRe2('(?=a)b')).toEqual({ ok: false, reason: 'lookaround_not_allowed' });
  });

  it.each([
    ['nested quantifier', '(a+)+$'],
    ['ambiguous alternation', '(a|aa)+c'],
    ['separated nested quantifier', '^(([a-z])+.)+[A-Z]([a-z])+$'],
  ])('compiles the %s shape (%s)', (_label, pattern) => {
    expect(compileRe2(pattern).ok).toBe(true);
  });

  it("matches a catastrophic-backtracking pattern against worst-case input in well under a second", () => {
    const compiled = compileRe2('^(([a-z])+.)+[A-Z]([a-z])+$');
    if (!compiled.ok) throw new Error('expected pattern to compile');
    const evilInput = 'a'.repeat(40) + '!';
    const start = Date.now();
    compiled.re.test(evilInput);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('execAllRe2', () => {
  it('returns every match span', () => {
    const compiled = compileRe2('\\d{3}-\\d{2}-\\d{4}');
    if (!compiled.ok) throw new Error('expected pattern to compile');
    const spans = execAllRe2(compiled.re, 'a 123-45-6789 b 987-65-4321 c');
    expect(spans).toEqual([
      { start: 2, end: 13 },
      { start: 16, end: 27 },
    ]);
  });
});
