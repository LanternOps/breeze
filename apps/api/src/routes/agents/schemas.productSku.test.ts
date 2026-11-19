import { describe, expect, it } from 'vitest';
import { enrollSchema, updateHardwareSchema } from './schemas';

// #9593 — device_hardware.product_sku is varchar(100). An oversized value must
// not fail the whole hardware report on a Postgres length error, and a cut-off
// product number would misdirect a warranty lookup, so it is dropped.
describe.each([
  ['updateHardwareSchema', (productSku: unknown) => updateHardwareSchema.parse({ productSku }).productSku],
  ['enrollSchema.hardwareInfo', (productSku: unknown) => enrollSchema.parse({
    enrollmentKey: 'k', hostname: 'h', osType: 'linux', osVersion: '1', architecture: 'x64', agentVersion: '1.0.0',
    hardwareInfo: { productSku },
  }).hardwareInfo?.productSku],
])('%s productSku', (_name, parseSku) => {
  it('keeps a product number', () => {
    expect(parseSku('5S3F8EA#ABB')).toBe('5S3F8EA#ABB');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSku('  5S3F8EA#ABB ')).toBe('5S3F8EA#ABB');
  });

  it('keeps exactly 100 characters', () => {
    expect(parseSku('a'.repeat(100))).toBe('a'.repeat(100));
  });

  it.each([['over the column width', 'a'.repeat(101)], ['blank', '   ']])('drops a value that is %s', (_label, value) => {
    expect(parseSku(value)).toBeUndefined();
  });

  it('stays optional for agents older than the field', () => {
    expect(parseSku(undefined)).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(() => parseSku(42)).toThrow();
  });
});
