import { describe, expect, it } from 'vitest';
import { validateParameters } from './ScriptParametersForm';
import type { ScriptParameter } from './ScriptFormSchema';

describe('validateParameters', () => {
  it('returns null when there are no parameters', () => {
    expect(validateParameters([], {})).toBeNull();
  });

  it('returns null when all required parameters are present', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true },
      { name: 'count', type: 'number', required: true }
    ];
    const values = { message: 'hello', count: 5 };
    expect(validateParameters(params, values)).toBeNull();
  });

  it('returns null when optional parameters are missing', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: false }
    ];
    expect(validateParameters(params, {})).toBeNull();
  });

  it('returns error string when a required string param is missing', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, {})).toBe('Parameter "message" is required');
  });

  it('returns error string when a required string param is empty', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, { message: '' })).toBe('Parameter "message" is required');
  });

  it('returns error string when a required string param is whitespace only', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, { message: '   ' })).toBe('Parameter "message" is required');
  });

  it('returns the first missing required param error when multiple are missing', () => {
    const params: ScriptParameter[] = [
      { name: 'first', type: 'string', required: true },
      { name: 'second', type: 'string', required: true }
    ];
    const result = validateParameters(params, {});
    expect(result).toBe('Parameter "first" is required');
  });

  it('returns null when a required number param has value 0', () => {
    const params: ScriptParameter[] = [
      { name: 'count', type: 'number', required: true }
    ];
    // 0 is a valid number value — should not be treated as missing
    expect(validateParameters(params, { count: 0 })).toBeNull();
  });

  it('returns error when required param value is undefined', () => {
    const params: ScriptParameter[] = [
      { name: 'target', type: 'string', required: true }
    ];
    expect(validateParameters(params, { target: undefined })).toBe('Parameter "target" is required');
  });

  it('returns error when a required select param has empty string (placeholder)', () => {
    const params: ScriptParameter[] = [
      { name: 'env', type: 'select', required: true, options: 'a,b,c' }
    ];
    expect(validateParameters(params, { env: '' })).toBe('Parameter "env" is required');
  });

  it('returns null when a required boolean param has value false', () => {
    const params: ScriptParameter[] = [
      { name: 'flag', type: 'boolean', required: true }
    ];
    // false is an explicit choice — should not be treated as missing
    expect(validateParameters(params, { flag: false })).toBeNull();
  });

  it('returns error when a number param has NaN value', () => {
    const params: ScriptParameter[] = [
      { name: 'count', type: 'number', required: true }
    ];
    expect(validateParameters(params, { count: NaN })).toBe('Parameter "count" must be a valid number');
  });
});
