import { describe, it, expect } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './index';
import { CANONICALIZATION_VECTORS, BODY_32KIB_ASCII, BODY_32KIB_ASTRAL } from './vectors';

describe('canonicalizeArguments', () => {
  it('should have identical output for different key orders', () => {
    const obj1 = { b: 1, a: 2 };
    const obj2 = { a: 2, b: 1 };
    expect(canonicalizeArguments(obj1)).toBe(canonicalizeArguments(obj2));
  });

  it('should sort nested object keys', () => {
    const obj = { z: { b: 1, a: 2 }, a: 3 };
    const parsed = JSON.parse(canonicalizeArguments(obj));
    expect(Object.keys(parsed)).toEqual(['a', 'z']);
    expect(Object.keys(parsed.z)).toEqual(['a', 'b']);
  });

  it('should preserve array order', () => {
    expect(canonicalizeArguments({ arr: [1, 2, 3] })).not.toBe(canonicalizeArguments({ arr: [3, 2, 1] }));
  });

  it('should drop undefined properties', () => {
    expect(canonicalizeArguments({ a: 1, b: undefined, c: 2 })).toBe(canonicalizeArguments({ a: 1, c: 2 }));
  });

  it('should render undefined in arrays as nulls', () => {
    expect(JSON.parse(canonicalizeArguments({ arr: [1, undefined, 3] })).arr).toEqual([1, null, 3]);
  });

  it('should throw on circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalizeArguments(obj)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj)).toThrow('circular argument structure');
  });

  it('should allow a shared (non-circular) object instance reused at sibling keys', () => {
    const shared = { m: 1, n: 2 };
    const parsed = JSON.parse(canonicalizeArguments({ x: shared, y: shared }));
    expect(parsed.x).toEqual({ m: 1, n: 2 });
    expect(parsed.y).toEqual({ m: 1, n: 2 });
    expect(canonicalizeArguments({ x: shared })).toBe(JSON.stringify({ x: { m: 1, n: 2 } }));
  });

  it('should allow a shared (non-circular) object instance reused within an array', () => {
    const shared = { a: 1 };
    expect(JSON.parse(canonicalizeArguments({ arr: [shared, shared] })).arr).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it('should allow a deep shared reference reused across sibling subtrees', () => {
    const sharedLeaf = { id: 'leaf', value: 42 };
    const obj = {
      branchA: { nested: { leaf: sharedLeaf } },
      branchB: { otherNested: { leaf: sharedLeaf } },
    };
    expect(() => canonicalizeArguments(obj)).not.toThrow();
    const parsed = JSON.parse(canonicalizeArguments(obj));
    expect(parsed.branchA.nested.leaf).toEqual({ id: 'leaf', value: 42 });
    expect(parsed.branchB.otherNested.leaf).toEqual({ id: 'leaf', value: 42 });
  });

  it.each([
    ['functions', { fn: () => {} }],
    ['symbols', { sym: Symbol('test') }],
    ['bigints', { big: BigInt(123) }],
  ])('should throw on %s', (_label, obj) => {
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(
      'argument value is not JSON-serializable'
    );
  });

  it('should handle null and primitive values', () => {
    const parsed = JSON.parse(canonicalizeArguments({ null: null, str: 'test', num: 42, bool: true }));
    expect(parsed).toEqual({ bool: true, null: null, num: 42, str: 'test' });
  });

  it('should handle nested arrays with objects', () => {
    const parsed = JSON.parse(canonicalizeArguments({ arr: [{ z: 1, a: 2 }, { b: 3, a: 4 }] }));
    expect(Object.keys(parsed.arr[0])).toEqual(['a', 'z']);
    expect(Object.keys(parsed.arr[1])).toEqual(['a', 'b']);
  });
});

describe('computeArgumentDigest', () => {
  it('should return a 64-character lowercase hex string', () => {
    expect(computeArgumentDigest('test')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic for the same input', () => {
    const canonical = canonicalizeArguments({ a: 1, b: 2 });
    expect(computeArgumentDigest(canonical)).toBe(computeArgumentDigest(canonical));
  });

  it('should differ for different inputs', () => {
    expect(computeArgumentDigest(canonicalizeArguments({ a: 1 }))).not.toBe(
      computeArgumentDigest(canonicalizeArguments({ a: 2 }))
    );
  });

  it('should match for canonically equivalent inputs', () => {
    expect(computeArgumentDigest(canonicalizeArguments({ b: 1, a: 2 }))).toBe(
      computeArgumentDigest(canonicalizeArguments({ a: 2, b: 1 }))
    );
  });

  it('should handle the empty canonical string', () => {
    expect(computeArgumentDigest('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should differ for different array orders', () => {
    expect(computeArgumentDigest(canonicalizeArguments({ arr: [1, 2, 3] }))).not.toBe(
      computeArgumentDigest(canonicalizeArguments({ arr: [3, 2, 1] }))
    );
  });
});

/**
 * The cross-package contract. These same vectors are executed by `apps/api` and, once it
 * exists, by the communications executor. Expectations come from the frozen corpus and are
 * never recomputed — see the header of `vectors.ts`.
 */
describe('frozen conformance vectors', () => {
  it.each(CANONICALIZATION_VECTORS.map((v) => [v.name, v] as const))(
    'vector %s produces the frozen digest',
    (_name, vector) => {
      const canonical = canonicalizeArguments(vector.input);
      if (vector.canonical !== undefined) expect(canonical).toBe(vector.canonical);
      expect(computeArgumentDigest(canonical)).toBe(vector.digest);
    }
  );
});

/**
 * Guards on the corpus itself. A conformance suite is only as good as its inputs, and
 * several of these vectors would silently degrade into tautologies if their inputs were
 * "tidied" by an editor or a formatter — a decomposed é normalized to a precomposed one,
 * a zero-width character stripped, CRLF rewritten to LF on checkout. Each check below
 * fails loudly in that case instead of leaving a vector that passes against anything.
 */
describe('corpus integrity', () => {
  const byName = new Map(CANONICALIZATION_VECTORS.map((v) => [v.name, v]));

  it('has unique vector names', () => {
    expect(byName.size).toBe(CANONICALIZATION_VECTORS.length);
  });

  it('has a distinct digest for every vector', () => {
    const digests = new Set(CANONICALIZATION_VECTORS.map((v) => v.digest));
    expect(digests.size).toBe(CANONICALIZATION_VECTORS.length);
  });

  it('has well-formed frozen digests', () => {
    for (const v of CANONICALIZATION_VECTORS) expect(v.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the normalization vector genuinely un-normalized', () => {
    const { subject, alt } = byName.get('no-unicode-normalization')!.input as { subject: string; alt: string };
    // Distinct code points that are canonically equivalent under NFC. If a tool ever
    // normalizes this file, these two become identical and the vector stops proving
    // anything at all.
    expect(subject).not.toBe(alt);
    expect(subject.normalize('NFC')).toBe(alt.normalize('NFC'));
    expect([...subject].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0xe9]);
    expect([...alt].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x65, 0x301]);
  });

  it('keeps the invisible-control characters present', () => {
    const { subject, body } = byName.get('invisible-controls-survive')!.input as { subject: string; body: string };
    expect(subject).toContain('​'); // zero-width space
    expect(subject).toContain('‮'); // right-to-left override
    expect(body).toContain('﻿'); // BOM / zero-width no-break space
  });

  it('keeps CRLF and LF distinct rather than incidentally equal', () => {
    const crlf = byName.get('crlf-preserved')!;
    const lf = byName.get('lf-only-differs-from-crlf')!;
    expect((crlf.input as { body: string }).body).toContain('\r\n');
    expect((lf.input as { body: string }).body).not.toContain('\r');
    expect(crlf.digest).not.toBe(lf.digest);
  });

  it('keeps the lone surrogate lone', () => {
    const body = (byName.get('lone-surrogate-escaped')!.input as { body: string }).body;
    expect(body).toContain('\uD800');
    expect(body.codePointAt(6)).toBe(0xd800); // still unpaired, not silently repaired
  });

  it('sizes the oversized bodies at exactly 32 KiB of UTF-16 code units', () => {
    expect(BODY_32KIB_ASCII.length).toBe(32 * 1024);
    expect(BODY_32KIB_ASTRAL.length).toBe(32 * 1024);
    // Astral filler is surrogate pairs, so code points are half the code units.
    expect([...BODY_32KIB_ASTRAL].length).toBe(16 * 1024);
  });
});
