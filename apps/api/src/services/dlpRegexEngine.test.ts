import { describe, it, expect } from 'vitest';
import { compileRe2, execAllRe2 } from './dlpRegexEngine';

describe('compileRe2', () => {
  it('compiles an ordinary pattern', () => {
    const r = compileRe2('\\d{3}-\\d{2}-\\d{4}');
    expect(r.ok).toBe(true);
  });

  it('rejects a backreference', () => {
    const r = compileRe2('(a)\\1');
    expect(r).toEqual({ ok: false, reason: 'backreference_not_allowed' });
  });

  it('rejects a lookahead', () => {
    const r = compileRe2('(?=a)b');
    expect(r).toEqual({ ok: false, reason: 'lookaround_not_allowed' });
  });

  it('rejects a negative lookahead', () => {
    const r = compileRe2('a(?!b)');
    expect(r).toEqual({ ok: false, reason: 'lookaround_not_allowed' });
  });

  it('rejects a lookbehind', () => {
    const r = compileRe2('(?<=a)b');
    expect(r).toEqual({ ok: false, reason: 'lookaround_not_allowed' });
  });

  // Classic catastrophic-backtracking shapes: RE2 compiles and matches them
  // in linear time (no backtracking engine to blow up), so unlike a
  // string-heuristic gate these are ACCEPTED, not rejected. Safety comes
  // from the engine, not from refusing the shape.
  it.each([
    ['nested quantifier', '(a+)+$'],
    ['ambiguous alternation', '(a|aa)+c'],
    // The reviewer's finding: a quantified atom separated from the group's
    // closing paren by literal content, so a same-immediately-before-paren
    // heuristic misses it.
    ['separated nested quantifier', '^(([a-z])+.)+[A-Z]([a-z])+$'],
  ])('compiles the %s shape (%s) — RE2 has no backtracking behavior', (_label, pattern) => {
    expect(compileRe2(pattern).ok).toBe(true);
  });

  it('matches a catastrophic-backtracking pattern against worst-case input in well under a second', () => {
    const compiled = compileRe2('^(([a-z])+.)+[A-Z]([a-z])+$');
    if (!compiled.ok) throw new Error('expected pattern to compile');
    const evilInput = 'a'.repeat(40) + '!'; // ~1s+ on a backtracking engine
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

  it('matches correctly for legitimate DLP shapes (SSN, card-ish, email, API key)', () => {
    const cases: Array<[string, string, string]> = [
      ['\\d{3}-\\d{2}-\\d{4}', 'ssn 123-45-6789 end', '123-45-6789'],
      ['\\d{4}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}', 'card 4111 1111 1111 1111 end', '4111 1111 1111 1111'],
      ['[\\w.+-]+@[\\w-]+\\.[\\w.-]+', 'mail foo.bar+baz@example.com end', 'foo.bar+baz@example.com'],
      ['sk-[A-Za-z0-9]{16,}', 'key sk-abcdefghijklmnop1234 end', 'sk-abcdefghijklmnop1234'],
    ];
    for (const [pattern, text, expected] of cases) {
      const compiled = compileRe2(pattern);
      if (!compiled.ok) throw new Error(`expected ${pattern} to compile`);
      const spans = execAllRe2(compiled.re, text);
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(text.slice(span.start, span.end)).toBe(expected);
    }
  });

  it('does not stall on a zero-width-capable pattern', () => {
    const compiled = compileRe2('a*');
    if (!compiled.ok) throw new Error('expected pattern to compile');
    const spans = execAllRe2(compiled.re, 'baab');
    // Only the non-zero-width match ("aa") is reported.
    expect(spans).toEqual([{ start: 1, end: 3 }]);
  });
});
