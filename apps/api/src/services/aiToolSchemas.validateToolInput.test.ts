import { describe, expect, it } from 'vitest';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

const TEST_UUID = '00000000-0000-0000-0000-000000000001';

describe('validateToolInput error formatting', () => {
  it('rejects an unregistered tool', () => {
    const result = validateToolInput('not_a_real_tool', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No input schema registered');
    }
  });

  it('accepts valid input', () => {
    expect(validateToolInput('manage_patches', { action: 'list' })).toEqual({ success: true });
  });

  // Regression for #2604: object-level refinements carry an empty `path`, so the
  // old `${path}: ${message}` formatting produced a doubled colon
  // ("Invalid input: : patchIds and deviceIds are required for install").
  it('does not emit a doubled colon for object-level refinement failures', () => {
    const result = validateToolInput('manage_patches', { action: 'install' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid input: patchIds and deviceIds are required for install');
      expect(result.error).not.toContain(': :');
    }
  });

  it('still prefixes the field path for field-level failures', () => {
    // `action` must be one of the enum values — this is a field-level issue with
    // a non-empty path, so the path prefix must be preserved.
    const result = validateToolInput('manage_patches', { action: 'not_an_action' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('action:');
      expect(result.error).not.toContain(': :');
    }
  });

  it('renders another object-level refinement message without a leading colon', () => {
    // A second refinement (scan requires deviceIds) confirms the empty-path
    // handling is not specific to the install message.
    const result = validateToolInput('manage_patches', { action: 'scan' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid input: deviceIds is required for scan');
    }
  });
});

// Regression for #3094: a set_device_context call whose values contain
// parentheses ("169.254.7.26 (APIPA)") must validate — the prod call vanished
// at the SDK layer without a tool_result, and the model's paren-sanitizing
// retry implied the schema rejected parenthesized text. Pin that both the
// summary and details values accept parentheses, and that the realistic
// SDK-layer rejections for this tool are the type/length failures, not parens.
describe('set_device_context parenthesized input (#3094)', () => {
  const base = {
    deviceId: '00000000-0000-0000-0000-000000000001',
    contextType: 'quirk',
  };

  it('accepts parentheses in details values', () => {
    expect(
      validateToolInput('set_device_context', {
        ...base,
        summary: 'NIC fell back to APIPA',
        details: { ethernetIP: '169.254.7.26 (APIPA)' },
      })
    ).toEqual({ success: true });
  });

  it('accepts parentheses in the summary', () => {
    expect(
      validateToolInput('set_device_context', {
        ...base,
        summary: 'Ethernet has APIPA address 169.254.7.26 (APIPA) — DHCP unreachable',
      })
    ).toEqual({ success: true });
  });

  it('rejects details passed as a JSON-encoded string (a realistic silent-drop trigger)', () => {
    const result = validateToolInput('set_device_context', {
      ...base,
      summary: 's',
      details: '{"ethernetIP": "169.254.7.26 (APIPA)"}',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a summary over 255 chars (a realistic silent-drop trigger)', () => {
    const result = validateToolInput('set_device_context', {
      ...base,
      summary: `169.254.7.26 (APIPA) ${'x'.repeat(255)}`,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('summary');
    }
  });
});

// Multi-currency wave 4 (#3776): the assembly actions take an optional header
// currency override. Spec §4 mandates the shared `currencyCodeSchema` for every
// currency field — a bare `length(3)` would admit unsupported codes.
describe('manage_invoices currencyCode (#3776)', () => {
  const base = { action: 'assemble_from_org', orgId: TEST_UUID, from: '2026-06-01', to: '2026-06-30' };

  it('accepts and normalizes a supported code', () => {
    const r = toolInputSchemas.manage_invoices!.safeParse({ ...base, currencyCode: 'eur' });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { currencyCode?: string }).currencyCode).toBe('EUR');
  });

  it('rejects an unknown code and a three-decimal code outside SUPPORTED_CURRENCIES', () => {
    expect(validateToolInput('manage_invoices', { ...base, currencyCode: 'ZZZ' }).success).toBe(false);
    expect(validateToolInput('manage_invoices', { ...base, currencyCode: 'BHD' }).success).toBe(false);
  });

  it('stays optional', () => {
    expect(validateToolInput('manage_invoices', base)).toEqual({ success: true });
  });
});
