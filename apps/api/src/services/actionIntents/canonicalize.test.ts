import { describe, it, expect } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

describe('canonicalizeArguments', () => {
  it('should have identical output for different key orders', () => {
    const obj1 = { b: 1, a: 2 };
    const obj2 = { a: 2, b: 1 };
    expect(canonicalizeArguments(obj1)).toBe(canonicalizeArguments(obj2));
  });

  it('should sort nested object keys', () => {
    const obj = { z: { b: 1, a: 2 }, a: 3 };
    const canonical = canonicalizeArguments(obj);
    const parsed = JSON.parse(canonical);
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['a', 'z']);
    expect(Object.keys(parsed.z)).toEqual(['a', 'b']);
  });

  it('should preserve array order', () => {
    const obj1 = { arr: [1, 2, 3] };
    const obj2 = { arr: [3, 2, 1] };
    expect(canonicalizeArguments(obj1)).not.toBe(canonicalizeArguments(obj2));
  });

  it('should drop undefined properties', () => {
    const obj1 = { a: 1, b: undefined, c: 2 };
    const obj2 = { a: 1, c: 2 };
    expect(canonicalizeArguments(obj1)).toBe(canonicalizeArguments(obj2));
  });

  it('should drop undefined in arrays as nulls', () => {
    const obj1 = { arr: [1, undefined, 3] };
    const canonical = canonicalizeArguments(obj1);
    const parsed = JSON.parse(canonical);
    expect(parsed.arr).toEqual([1, null, 3]);
  });

  it('should throw on circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalizeArguments(obj)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj)).toThrow('circular argument structure');
  });

  it('should throw on functions', () => {
    const obj = { fn: () => {} };
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(
      'argument value is not JSON-serializable'
    );
  });

  it('should throw on symbols', () => {
    const obj = { sym: Symbol('test') };
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(
      'argument value is not JSON-serializable'
    );
  });

  it('should throw on bigints', () => {
    const obj = { big: BigInt(123) };
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(TypeError);
    expect(() => canonicalizeArguments(obj as Record<string, unknown>)).toThrow(
      'argument value is not JSON-serializable'
    );
  });

  it('should handle null and primitive values', () => {
    const obj = { null: null, str: 'test', num: 42, bool: true };
    const canonical = canonicalizeArguments(obj);
    const parsed = JSON.parse(canonical);
    expect(parsed).toEqual({ bool: true, null: null, num: 42, str: 'test' });
  });

  it('should handle nested arrays with objects', () => {
    const obj = { arr: [{ z: 1, a: 2 }, { b: 3, a: 4 }] };
    const canonical = canonicalizeArguments(obj);
    const parsed = JSON.parse(canonical);
    expect(Object.keys(parsed.arr[0])).toEqual(['a', 'z']);
    expect(Object.keys(parsed.arr[1])).toEqual(['a', 'b']);
  });
});

describe('computeArgumentDigest', () => {
  it('should return 64-character lowercase hex string', () => {
    const digest = computeArgumentDigest('test');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce consistent digest for same input', () => {
    const canonical = canonicalizeArguments({ a: 1, b: 2 });
    const digest1 = computeArgumentDigest(canonical);
    const digest2 = computeArgumentDigest(canonical);
    expect(digest1).toBe(digest2);
  });

  it('should produce different digests for different inputs', () => {
    const canonical1 = canonicalizeArguments({ a: 1 });
    const canonical2 = canonicalizeArguments({ a: 2 });
    const digest1 = computeArgumentDigest(canonical1);
    const digest2 = computeArgumentDigest(canonical2);
    expect(digest1).not.toBe(digest2);
  });

  it('should produce same digest for canonically equivalent inputs', () => {
    const obj1 = { b: 1, a: 2 };
    const obj2 = { a: 2, b: 1 };
    const canonical1 = canonicalizeArguments(obj1);
    const canonical2 = canonicalizeArguments(obj2);
    const digest1 = computeArgumentDigest(canonical1);
    const digest2 = computeArgumentDigest(canonical2);
    expect(digest1).toBe(digest2);
  });

  it('should handle empty canonical string', () => {
    const digest = computeArgumentDigest('');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce different digests for different array orders', () => {
    const canonical1 = canonicalizeArguments({ arr: [1, 2, 3] });
    const canonical2 = canonicalizeArguments({ arr: [3, 2, 1] });
    const digest1 = computeArgumentDigest(canonical1);
    const digest2 = computeArgumentDigest(canonical2);
    expect(digest1).not.toBe(digest2);
  });
});

describe('integration: canonicalize + digest round-trip', () => {
  it('should produce stable digests across multiple canonicalizations', () => {
    const obj = {
      userId: '123',
      action: 'deploy',
      params: {
        timeout: 5000,
        retry: true,
        targets: ['server-1', 'server-2'],
      },
    };

    const digest1 = computeArgumentDigest(canonicalizeArguments(obj));
    const digest2 = computeArgumentDigest(canonicalizeArguments(obj));
    expect(digest1).toBe(digest2);
  });

  it('should produce same digest regardless of input key order', () => {
    const obj1 = {
      userId: '123',
      action: 'deploy',
      params: { timeout: 5000, retry: true },
    };

    const obj2 = {
      params: { retry: true, timeout: 5000 },
      action: 'deploy',
      userId: '123',
    };

    const digest1 = computeArgumentDigest(canonicalizeArguments(obj1));
    const digest2 = computeArgumentDigest(canonicalizeArguments(obj2));
    expect(digest1).toBe(digest2);
  });
});
