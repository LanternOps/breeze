import { describe, it, expect } from 'vitest';
import { detectionRuleSchema, detectionRulesSchema } from './softwareDetection';

describe('detectionRuleSchema', () => {
  it('accepts a registry clause with only a key path', () => {
    const r = detectionRuleSchema.safeParse({
      type: 'registry',
      path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Foo',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a registry clause with hive, value name and expected data', () => {
    const r = detectionRuleSchema.safeParse({
      type: 'registry',
      hive: 'HKCU',
      path: 'SOFTWARE\\Acme\\App',
      valueName: 'Version',
      valueData: '1.2.3',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown registry hive', () => {
    const r = detectionRuleSchema.safeParse({ type: 'registry', hive: 'HKXX', path: 'SOFTWARE\\X' });
    expect(r.success).toBe(false);
  });

  it('accepts a file_exists clause', () => {
    const r = detectionRuleSchema.safeParse({ type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' });
    expect(r.success).toBe(true);
  });

  it('accepts an msi_product_code clause with and without braces', () => {
    expect(
      detectionRuleSchema.safeParse({
        type: 'msi_product_code',
        productCode: '{3F2504E0-4F89-41D3-9A0C-0305E82C3301}',
      }).success,
    ).toBe(true);
    expect(
      detectionRuleSchema.safeParse({
        type: 'msi_product_code',
        productCode: '3F2504E0-4F89-41D3-9A0C-0305E82C3301',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-GUID product code', () => {
    const r = detectionRuleSchema.safeParse({ type: 'msi_product_code', productCode: 'not-a-guid' });
    expect(r.success).toBe(false);
  });

  it('accepts a file_version clause with each supported operator', () => {
    for (const operator of ['>=', '>', '==', '<=', '<'] as const) {
      const r = detectionRuleSchema.safeParse({
        type: 'file_version',
        path: 'C:\\Program Files\\Acme\\app.exe',
        operator,
        version: '1.2.3.4',
      });
      expect(r.success, `operator ${operator}`).toBe(true);
    }
  });

  it('accepts a file_version clause with a short (1–3 component) version', () => {
    expect(
      detectionRuleSchema.safeParse({
        type: 'file_version',
        path: 'C:\\app.exe',
        operator: '>=',
        version: '10',
      }).success,
    ).toBe(true);
    expect(
      detectionRuleSchema.safeParse({
        type: 'file_version',
        path: 'C:\\app.exe',
        operator: '>=',
        version: '1.2.3',
      }).success,
    ).toBe(true);
  });

  it('rejects a file_version clause with an unknown operator', () => {
    const r = detectionRuleSchema.safeParse({
      type: 'file_version',
      path: 'C:\\app.exe',
      operator: '=>',
      version: '1.2.3',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a file_version clause with a non-numeric or malformed version', () => {
    expect(
      detectionRuleSchema.safeParse({ type: 'file_version', path: 'C:\\x', operator: '>=', version: '1.2.x' })
        .success,
    ).toBe(false);
    expect(
      detectionRuleSchema.safeParse({ type: 'file_version', path: 'C:\\x', operator: '>=', version: '1.2.3.4.5' })
        .success,
    ).toBe(false);
    expect(
      detectionRuleSchema.safeParse({ type: 'file_version', path: 'C:\\x', operator: '>=', version: '' }).success,
    ).toBe(false);
  });

  it('rejects a file_version clause with an empty path', () => {
    const r = detectionRuleSchema.safeParse({ type: 'file_version', path: '', operator: '>=', version: '1.0' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown clause type', () => {
    const r = detectionRuleSchema.safeParse({ type: 'wmi_query', query: 'SELECT * FROM Win32_Product' });
    expect(r.success).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(detectionRuleSchema.safeParse({ type: 'file_exists', path: '' }).success).toBe(false);
    expect(detectionRuleSchema.safeParse({ type: 'registry', path: '' }).success).toBe(false);
  });
});

describe('detectionRulesSchema', () => {
  it('accepts an empty array', () => {
    expect(detectionRulesSchema.safeParse([]).success).toBe(true);
  });

  it('accepts a heterogeneous AND set', () => {
    const r = detectionRulesSchema.safeParse([
      { type: 'registry', path: 'SOFTWARE\\Acme\\App' },
      { type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' },
      { type: 'msi_product_code', productCode: '{3F2504E0-4F89-41D3-9A0C-0305E82C3301}' },
      { type: 'file_version', path: 'C:\\Program Files\\Acme\\app.exe', operator: '>=', version: '1.2.3' },
    ]);
    expect(r.success).toBe(true);
  });

  it('rejects a set with one invalid clause', () => {
    const r = detectionRulesSchema.safeParse([
      { type: 'file_exists', path: 'C:\\ok' },
      { type: 'msi_product_code', productCode: 'bad' },
    ]);
    expect(r.success).toBe(false);
  });

  it('rejects more than 20 clauses', () => {
    const many = Array.from({ length: 21 }, () => ({ type: 'file_exists' as const, path: 'C:\\x' }));
    expect(detectionRulesSchema.safeParse(many).success).toBe(false);
  });
});
