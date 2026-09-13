import { describe, expect, it } from 'vitest';
import { DEVICE_FUNCTION_KEYS, isDeviceFunctionKey, parseFunctionKey, setDeviceFunctionSchema } from './deviceFunctions';

describe('device function SSOT', () => {
  it('lists the v1 functions with unknown last', () => {
    expect(DEVICE_FUNCTION_KEYS[0]).toBe('domain_controller');
    expect(DEVICE_FUNCTION_KEYS[DEVICE_FUNCTION_KEYS.length - 1]).toBe('unknown');
    expect(new Set(DEVICE_FUNCTION_KEYS).size).toBe(DEVICE_FUNCTION_KEYS.length);
  });
  it('accepts known keys and custom slugs, rejects the rest', () => {
    expect(isDeviceFunctionKey('file_server')).toBe(true);
    expect(isDeviceFunctionKey('custom:pos-terminal')).toBe(false);
    expect(parseFunctionKey('file_server')).toEqual({ kind: 'known', key: 'file_server' });
    expect(parseFunctionKey('custom:pos-terminal')).toEqual({ kind: 'custom', slug: 'pos-terminal' });
    expect(parseFunctionKey('custom:P')).toBeNull();
    expect(parseFunctionKey('custom:has space')).toBeNull();
    expect(parseFunctionKey('nonsense')).toBeNull();
  });
});

describe('setDeviceFunctionSchema', () => {
  it('accepts a known key, a custom key with a label, and null (clear)', () => {
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'file_server' }).success).toBe(true);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'custom:pos', label: 'POS terminal' }).success).toBe(true);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: null }).success).toBe(true);
  });
  it('rejects an unknown key, a custom key without a label, and unknown fields', () => {
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'nonsense' }).success).toBe(false);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'custom:pos' }).success).toBe(false);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'custom:pos', label: '   ' }).success).toBe(false);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'file_server', extra: 1 }).success).toBe(false);
    expect(setDeviceFunctionSchema.safeParse({ functionKey: 'file_server', label: 'x'.repeat(81) }).success).toBe(false);
  });
  it('trims the label', () => {
    const parsed = setDeviceFunctionSchema.parse({ functionKey: 'custom:pos', label: '  POS  ' });
    expect(parsed.label).toBe('POS');
  });
});
