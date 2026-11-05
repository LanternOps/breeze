import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { utf16Max, utf8MaxBytes } from './unitLength';

// zod 4.6 measures `.max(N)` in Unicode code points (#9976): N emoji pass a
// `.max(N)` although they are 2N UTF-16 units and 4N UTF-8 bytes. These
// helpers pin a limit to the unit the downstream sink actually counts.
const EMOJI = '\u{1F600}'; // 1 code point, 2 UTF-16 units, 4 UTF-8 bytes
const CJK = '中'; // 1 code point, 1 UTF-16 unit, 3 UTF-8 bytes

describe('zod 4.6 baseline (why the helpers exist)', () => {
  it('.max(N) admits N astral code points', () => {
    expect(z.string().max(4).safeParse(EMOJI.repeat(4)).success).toBe(true);
  });
});

describe('utf16Max', () => {
  const schema = z.string().max(4).check(utf16Max(4));

  it('accepts exactly N UTF-16 units', () => {
    expect(schema.safeParse('abcd').success).toBe(true);
    expect(schema.safeParse(EMOJI.repeat(2)).success).toBe(true);
    expect(schema.safeParse(CJK.repeat(4)).success).toBe(true);
  });

  it('rejects astral text whose code points fit but UTF-16 units do not', () => {
    const result = schema.safeParse(EMOJI.repeat(3));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', origin: 'string', maximum: 4 });
  });

  it('uses a caller-supplied message', () => {
    const result = z.string().check(utf16Max(1, 'too long')).safeParse(EMOJI);
    expect(result.error?.issues[0]?.message).toBe('too long');
  });
});

describe('utf8MaxBytes', () => {
  const schema = z.string().max(12).check(utf8MaxBytes(12));

  it('accepts exactly N UTF-8 bytes', () => {
    expect(schema.safeParse('a'.repeat(12)).success).toBe(true);
    expect(schema.safeParse(EMOJI.repeat(3)).success).toBe(true);
    expect(schema.safeParse(CJK.repeat(4)).success).toBe(true);
  });

  it('rejects non-ASCII text whose code points fit but bytes do not', () => {
    expect(schema.safeParse(CJK.repeat(5)).success).toBe(false);
    const result = schema.safeParse(EMOJI.repeat(4));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', origin: 'string', maximum: 12 });
  });

  it('accepts the object form of params', () => {
    const result = z.string().check(utf8MaxBytes(1, { message: 'over budget' })).safeParse(CJK);
    expect(result.error?.issues[0]?.message).toBe('over budget');
  });

  it('runs later checks by default and stops them with abort: true', () => {
    const later = (abort: boolean) => z.string().check(utf8MaxBytes(1, { abort })).refine(() => false, 'later')
      .safeParse(CJK).error?.issues.map((i) => i.message);
    expect(later(false)).toHaveLength(2);
    expect(later(true)).toHaveLength(1);
  });

  it('composes after other checks without changing the inferred type', () => {
    const named = z.object({ name: z.string().min(1).check(utf8MaxBytes(3)) });
    const parsed: { name: string } = named.parse({ name: 'abc' });
    expect(parsed.name).toBe('abc');
    expect(named.safeParse({ name: '' }).success).toBe(false);
  });
});
