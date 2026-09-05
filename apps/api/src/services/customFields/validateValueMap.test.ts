import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn(),
}));

import { validateCustomFieldMap } from './validateValueMap';
import { loadVisibleCustomFieldDefinitions } from './queries';
import type { VisibleCustomFieldDefinition } from './queries';

const ORG_ID = 'org-1';

function def(overrides: Partial<VisibleCustomFieldDefinition> & { fieldKey: string }): VisibleCustomFieldDefinition {
  return {
    id: `def-${overrides.fieldKey}`,
    fieldKey: overrides.fieldKey,
    name: overrides.fieldKey,
    type: overrides.type ?? 'text',
    options: overrides.options ?? null,
    deviceTypes: overrides.deviceTypes ?? null,
    required: overrides.required ?? false,
    scriptWrite: overrides.scriptWrite ?? false,
    orgId: overrides.orgId ?? ORG_ID,
    partnerId: overrides.partnerId ?? null,
  };
}

describe('validateCustomFieldMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is all-or-nothing on a MIXED valid+invalid map: collects every rejection, applies none', async () => {
    // The whole point of this file existing is atomic behaviour across a
    // multi-key map — a single-key test can't distinguish "atomic" from
    // "the one field it saw happened to fail".
    vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
      def({ fieldKey: 'rack_units', type: 'number' }),
      def({ fieldKey: 'tier', type: 'dropdown', options: { choices: ['gold'] } }),
      def({ fieldKey: 'notes', type: 'text' }),
    ]);

    const result = await validateCustomFieldMap(ORG_ID, null, {
      rack_units: 'abc', // invalid_type
      tier: 'bronze', // not_a_choice
      notes: 'a valid note', // would be fine on its own
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.rejected.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey))).toEqual([
      { fieldKey: 'rack_units', reason: 'invalid_type' },
      { fieldKey: 'tier', reason: 'not_a_choice' },
    ]);
    // The valid `notes` key must NOT sneak into a partial result — there is no
    // `values` key at all when `ok: false`.
    expect(result).not.toHaveProperty('values');
  });

  it('applies every field, all coerced, when the whole map is valid', async () => {
    vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
      def({ fieldKey: 'rack_units', type: 'number' }),
      def({ fieldKey: 'ready', type: 'boolean' }),
    ]);

    const result = await validateCustomFieldMap(ORG_ID, null, { rack_units: '4', ready: 'true' });

    expect(result).toEqual({ ok: true, values: { rack_units: 4, ready: true } });
  });

  it('rejects a key with no visible definition as unknown_field', async () => {
    vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([]);
    const result = await validateCustomFieldMap(ORG_ID, null, { nope: 'x' });
    expect(result).toEqual({ ok: false, rejected: [{ fieldKey: 'nope', reason: 'unknown_field' }] });
  });

  describe('deviceTypes applicability gate', () => {
    it('rejects a value for a definition scoped to a different device type', async () => {
      vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
        def({ fieldKey: 'rustdesk_id', type: 'text', deviceTypes: ['windows'] }),
      ]);

      const result = await validateCustomFieldMap('org-1', 'macos', { rustdesk_id: 'abc123' });

      expect(result).toEqual({
        ok: false,
        rejected: [{ fieldKey: 'rustdesk_id', reason: 'not_applicable_to_device' }],
      });
    });

    it('rejects when the device osType is unknown (null) and the definition is device-type-scoped', async () => {
      vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
        def({ fieldKey: 'rustdesk_id', type: 'text', deviceTypes: ['windows'] }),
      ]);

      const result = await validateCustomFieldMap('org-1', null, { rustdesk_id: 'abc123' });

      expect(result).toEqual({
        ok: false,
        rejected: [{ fieldKey: 'rustdesk_id', reason: 'not_applicable_to_device' }],
      });
    });

    it('applies the value when the device osType matches one of deviceTypes', async () => {
      vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
        def({ fieldKey: 'rustdesk_id', type: 'text', deviceTypes: ['windows', 'macos'] }),
      ]);

      const result = await validateCustomFieldMap('org-1', 'macos', { rustdesk_id: 'abc123' });

      expect(result).toEqual({ ok: true, values: { rustdesk_id: 'abc123' } });
    });

    it('does not gate at all when deviceTypes is null or empty (applies to every device)', async () => {
      vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue([
        def({ fieldKey: 'a', type: 'text', deviceTypes: null }),
        def({ fieldKey: 'b', type: 'text', deviceTypes: [] }),
      ]);

      const result = await validateCustomFieldMap('org-1', null, { a: '1', b: '2' });

      expect(result).toEqual({ ok: true, values: { a: '1', b: '2' } });
    });
  });
});
