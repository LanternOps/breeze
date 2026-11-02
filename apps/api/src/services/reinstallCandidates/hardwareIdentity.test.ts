import { describe, expect, it } from 'vitest';
import { isPlaceholderHardwareIdentity, serialManufacturerKey } from './hardwareIdentity';

describe('serial + manufacturer match key', () => {
  it('normalizes as the index expressions do', () => {
    expect(serialManufacturerKey('  c02xk0abjgh5 ', ' Dell Inc. ')).toEqual({ serialKey: 'C02XK0ABJGH5', manufacturerKey: 'dell inc.' });
  });

  it.each([
    ['To Be Filled By O.E.M.', 'ASUS'],
    ['System Serial Number', 'Dell'],
    ['SN1', 'System manufacturer'],
    ['SN1', 'O.E.M.'],
    ['Default string', 'Default string'],
    ['0', 'Lenovo'],
    ['SN1', ''],
    ['', 'Lenovo'],
    [null, 'Lenovo'],
    ['SN1', null],
  ])('refuses a placeholder or missing value (%s / %s)', (serial, vendor) => {
    expect(serialManufacturerKey(serial, vendor)).toBeNull();
  });

  it('flags the Go cleaner placeholders', () => {
    expect(isPlaceholderHardwareIdentity('  N/A ')).toBe(true);
    expect(isPlaceholderHardwareIdentity('Not   Specified')).toBe(true);
    expect(isPlaceholderHardwareIdentity('...unknown...')).toBe(true);
    expect(isPlaceholderHardwareIdentity('PF3ABCDE')).toBe(false);
  });
});
