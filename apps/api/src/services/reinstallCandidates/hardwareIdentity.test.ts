import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_IDENTITY_VALUES, isPlaceholderHardwareIdentity, serialManufacturerKey } from './hardwareIdentity';

describe('serial + manufacturer match key', () => {
  it('normalizes as the index expressions do', () => {
    expect(serialManufacturerKey('  c02xk0abjgh5 ', ' Dell Inc. ')).toEqual({ serialKey: 'C02XK0ABJGH5', manufacturerKey: 'dell inc.' });
  });

  it.each([
    ['To Be Filled By O.E.M.', 'ASUS'],
    ['System Serial Number', 'Dell'],
    ['Chassis Serial Number', 'Dell'],
    ['0123456789', 'Dell'],
    ['1234567890', 'Dell'],
    ['XXXXXXXX', 'Dell'],
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

  it('keeps the same placeholder list and substring rule as the Go agent', () => {
    for (const placeholder of PLACEHOLDER_IDENTITY_VALUES) expect(isPlaceholderHardwareIdentity(placeholder)).toBe(true);
    const goSource = readFileSync(
      resolve(__dirname, '../../../../../agent/internal/collectors/hardware.go'),
      'utf8',
    );
    const fn = goSource.slice(goSource.indexOf('func cleanHardwareIdentityValue('));
    const fnBody = fn.slice(0, fn.indexOf('\n}\n'));
    const switchStart = fnBody.indexOf('switch normalized {');
    expect(switchStart).toBeGreaterThan(0);
    const block = fnBody.slice(switchStart, fnBody.indexOf('\n\t}\n', switchStart));
    // Case labels only: each is followed by `,` or the closing `:`.
    const goList = [...block.matchAll(/"([^"]*)"[,:]/g)].map((m) => m[1]).sort();
    expect(goList.length).toBeGreaterThan(0);
    expect([...PLACEHOLDER_IDENTITY_VALUES].sort()).toEqual(goList);
    expect(fnBody).toContain('strings.Contains(normalized, "to be filled by")');
    expect(isPlaceholderHardwareIdentity('x To Be Filled By O.E.M. x')).toBe(true);
  });
});
