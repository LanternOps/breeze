import { describe, expect, it } from 'vitest';
import { DEVICE_FUNCTION_KEYS, isDeviceFunctionKey, parseFunctionKey } from './deviceFunctions';

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
