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

  it('accepts a file_version component at the 65535 ceiling but rejects above it', () => {
    expect(
      detectionRuleSchema.safeParse({
        type: 'file_version',
        path: 'C:\\app.exe',
        operator: '>=',
        version: '65535.65535.65535.65535',
      }).success,
    ).toBe(true);
    expect(
      detectionRuleSchema.safeParse({ type: 'file_version', path: 'C:\\app.exe', operator: '>=', version: '65536' })
        .success,
    ).toBe(false);
    expect(
      detectionRuleSchema.safeParse({ type: 'file_version', path: 'C:\\app.exe', operator: '>=', version: '70000.0.0.0' })
        .success,
    ).toBe(false);
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

describe('service_running clause (#6958)', () => {
  const parse = (serviceName: unknown) =>
    detectionRuleSchema.safeParse({ type: 'service_running', serviceName });

  it('accepts a plain service name', () => {
    expect(parse('ctrld').success).toBe(true);
  });

  it('accepts a display name containing spaces', () => {
    expect(parse('NextDNS Service').success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['leading dash', '-x'],
    ['NUL byte', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['DEL char', 'a\u007fb'],
    ['257 chars', 'x'.repeat(257)],
    // Same refusal set as the agent (agent/internal/remote/tools/
    // software_detection_service.go validServiceName): C1 controls incl. NEL,
    // and the Unicode line/paragraph separators some tooling treats as breaks.
    ['C1 start U+0080', 'a\u0080b'],
    ['NEL U+0085', 'a\u0085b'],
    ['C1 end U+009F', 'a\u009fb'],
    ['LINE SEPARATOR U+2028', 'a\u2028b'],
    ['PARAGRAPH SEPARATOR U+2029', 'a\u2029b'],
    ['leading C1', '\u0085ctrld'],
    // The agent bounds the name in UTF-8 bytes, so 129 two-byte chars (258 B)
    // must be refused here too rather than become an unevaluable clause.
    ['over 256 UTF-8 bytes', '\u00e9'.repeat(129)],
  ])('rejects %s', (_label, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('accepts non-ASCII names within 256 UTF-8 bytes', () => {
    expect(parse('Dienst f\u00fcr \u00dcn\u00efcode').success).toBe(true);
    expect(parse('\u00e9'.repeat(128)).success).toBe(true);
  });

  it('rejects a whitespace-only name (could never match a real service)', () => {
    expect(parse('   ').success).toBe(false);
    expect(parse('\t').success).toBe(false);
  });

  it('accepts dashes after the first character', () => {
    expect(parse('systemd-resolved').success).toBe(true);
    expect(parse('a-b').success).toBe(true);
  });

  it('accepts exactly 256 chars', () => {
    expect(parse('x'.repeat(256)).success).toBe(true);
  });

  it('is strict: rejects extra keys', () => {
    const r = detectionRuleSchema.safeParse({ type: 'service_running', serviceName: 'x', path: 'y' });
    expect(r.success).toBe(false);
  });

  it('is accepted inside a rule set', () => {
    expect(
      detectionRulesSchema.safeParse([{ type: 'service_running', serviceName: 'ctrld' }]).success,
    ).toBe(true);
  });
});
