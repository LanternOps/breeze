import { describe, expect, it } from 'vitest';
import {
  MAX_SCRIPT_PARAMETER_VALUE_LENGTH,
  MAX_SCRIPT_PARAMETERS,
  SCRIPT_PARAMETER_KEY_PATTERN,
  canonicalizeScriptParameters,
  scriptParametersSchema,
} from './scriptParameters';

describe('scriptParametersSchema', () => {
  it('accepts strings, finite numbers and booleans', () => {
    const result = scriptParametersSchema.safeParse({ s: 'hello', n: 3, b: true, zero: 0, f: false });
    expect(result.success).toBe(true);
  });

  it('rejects null', () => {
    expect(scriptParametersSchema.safeParse({ x: null }).success).toBe(false);
  });

  it('rejects undefined values explicitly present', () => {
    expect(scriptParametersSchema.safeParse({ x: undefined }).success).toBe(false);
  });

  it('rejects a nested object value', () => {
    expect(scriptParametersSchema.safeParse({ x: { nested: true } }).success).toBe(false);
  });

  it('rejects an array value', () => {
    expect(scriptParametersSchema.safeParse({ x: [1, 2, 3] }).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(scriptParametersSchema.safeParse({ x: Number.NaN }).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(scriptParametersSchema.safeParse({ x: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(scriptParametersSchema.safeParse({ x: Number.NEGATIVE_INFINITY }).success).toBe(false);
  });

  it.each([
    'has space',
    'a.b',
    'a=b',
    'a-b',
    '9leading',
    '',
  ])('rejects a key the agent could not turn into an env var name: %j', (key) => {
    expect(scriptParametersSchema.safeParse({ [key]: 'v' }).success).toBe(false);
  });

  it.each(['a', '_a', 'A_b9', 'valid_key'])('accepts a well-formed key: %j', (key) => {
    expect(scriptParametersSchema.safeParse({ [key]: 'v' }).success).toBe(true);
  });

  it('matches the documented key pattern directly', () => {
    expect(SCRIPT_PARAMETER_KEY_PATTERN.test('valid_key')).toBe(true);
    expect(SCRIPT_PARAMETER_KEY_PATTERN.test('bad key')).toBe(false);
  });

  it('enforces the parameter-count cap', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < MAX_SCRIPT_PARAMETERS + 1; i++) {
      tooMany[`k${i}`] = 'v';
    }
    expect(scriptParametersSchema.safeParse(tooMany).success).toBe(false);

    const atCap: Record<string, string> = {};
    for (let i = 0; i < MAX_SCRIPT_PARAMETERS; i++) {
      atCap[`k${i}`] = 'v';
    }
    expect(scriptParametersSchema.safeParse(atCap).success).toBe(true);
  });

  it('enforces the per-value canonicalized length cap', () => {
    const tooLong = 'x'.repeat(MAX_SCRIPT_PARAMETER_VALUE_LENGTH + 1);
    expect(scriptParametersSchema.safeParse({ k: tooLong }).success).toBe(false);

    const atCap = 'x'.repeat(MAX_SCRIPT_PARAMETER_VALUE_LENGTH);
    expect(scriptParametersSchema.safeParse({ k: atCap }).success).toBe(true);
  });

  it('measures the length cap against the CANONICALIZED string, not the raw type', () => {
    // A boolean canonicalizes to 'true'/'false' (4-5 chars) regardless of how
    // the schema might otherwise weigh a raw boolean — proves the cap check
    // runs `String(value).length`, not some type-specific short-circuit.
    expect(scriptParametersSchema.safeParse({ k: true }).success).toBe(true);
    expect(scriptParametersSchema.safeParse({ k: 123456789 }).success).toBe(true);
  });

  it('accepts an empty parameters object', () => {
    expect(scriptParametersSchema.safeParse({}).success).toBe(true);
  });
});

describe('canonicalizeScriptParameters', () => {
  it('canonicalizes a number and a boolean to their string forms', () => {
    expect(canonicalizeScriptParameters({ n: 3, b: true })).toEqual({ n: '3', b: 'true' });
  });

  it('canonicalizes false and zero (falsy but present) correctly', () => {
    expect(canonicalizeScriptParameters({ b: false, n: 0 })).toEqual({ b: 'false', n: '0' });
  });

  it('leaves an already-string value unchanged', () => {
    expect(canonicalizeScriptParameters({ s: 'already a string' })).toEqual({ s: 'already a string' });
  });

  it('returns an empty object for empty input', () => {
    expect(canonicalizeScriptParameters({})).toEqual({});
  });

  it('produces a Record<string, string> for every accepted shape', () => {
    const out = canonicalizeScriptParameters({ s: 'x', n: 1.5, b: true });
    for (const value of Object.values(out)) {
      expect(typeof value).toBe('string');
    }
  });
});
