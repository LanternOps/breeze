import { describe, expect, it } from 'vitest';
import { DEVICE_FUNCTION_KEYS } from '@breeze/shared';
import {
  DEVICE_FUNCTION_KEYS as WEB_KEYS,
  getDeviceFunctionLabel,
  getDeviceFunctionSourceColor,
  isCustomFunctionKey,
} from './deviceFunctions';

describe('lib/deviceFunctions', () => {
  it('re-exports the shared SSOT unchanged', () => {
    expect(WEB_KEYS).toBe(DEVICE_FUNCTION_KEYS);
  });

  it('labels known keys from the shared table, custom keys from their label, and falls back to the slug', () => {
    expect(getDeviceFunctionLabel('file_server')).toBe('File server');
    expect(getDeviceFunctionLabel('file_server', 'ignored')).toBe('File server');
    expect(getDeviceFunctionLabel('custom:pos', 'POS terminal')).toBe('POS terminal');
    expect(getDeviceFunctionLabel('custom:pos', '   ')).toBe('pos');
    expect(getDeviceFunctionLabel('custom:pos')).toBe('pos');
    expect(getDeviceFunctionLabel(null)).toBe('');
    expect(getDeviceFunctionLabel('weird')).toBe('weird');
  });

  it('identifies custom keys', () => {
    expect(isCustomFunctionKey('custom:pos')).toBe(true);
    expect(isCustomFunctionKey('kiosk')).toBe(false);
    expect(isCustomFunctionKey(null)).toBe(false);
  });

  it('colours ai and manual distinctly and falls back for anything else', () => {
    expect(getDeviceFunctionSourceColor('ai')).not.toBe(getDeviceFunctionSourceColor('manual'));
    expect(getDeviceFunctionSourceColor('bogus')).toBe(getDeviceFunctionSourceColor(null));
  });
});
