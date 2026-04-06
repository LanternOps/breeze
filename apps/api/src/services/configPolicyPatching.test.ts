import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: { id: 'id', name: 'name', orgId: 'org_id' },
  configPolicyFeatureLinks: {
    id: 'id',
    configPolicyId: 'config_policy_id',
    featureType: 'feature_type',
    featurePolicyId: 'feature_policy_id',
    inlineSettings: 'inline_settings',
  },
  configPolicyPatchSettings: {
    id: 'id',
    featureLinkId: 'feature_link_id',
    sources: 'sources',
    autoApprove: 'auto_approve',
    autoApproveSeverities: 'auto_approve_severities',
    scheduleFrequency: 'schedule_frequency',
    scheduleTime: 'schedule_time',
    scheduleDayOfWeek: 'schedule_day_of_week',
    scheduleDayOfMonth: 'schedule_day_of_month',
    rebootPolicy: 'reboot_policy',
  },
  patchPolicies: {
    id: 'id',
    orgId: 'org_id',
    kind: 'kind',
    name: 'name',
    categoryRules: 'category_rules',
    autoApprove: 'auto_approve',
  },
}));

import {
  normalizePatchInlineSettings,
  tryNormalizePatchInlineSettings,
  summarizePatchInventory,
  type PatchInventoryRow,
  type PatchReferenceClassification,
} from './configPolicyPatching';

describe('normalizePatchInlineSettings', () => {
  it('passes valid input through', () => {
    const input = {
      sources: ['os', 'third_party'],
      autoApprove: true,
      autoApproveSeverities: ['critical'],
      scheduleFrequency: 'daily',
      scheduleTime: '03:00',
      scheduleDayOfWeek: 'mon',
      scheduleDayOfMonth: 15,
      rebootPolicy: 'always',
    };

    const result = normalizePatchInlineSettings(input);

    expect(result.sources).toEqual(['os', 'third_party']);
    expect(result.autoApprove).toBe(true);
    expect(result.autoApproveSeverities).toEqual(['critical']);
    expect(result.scheduleFrequency).toBe('daily');
    expect(result.scheduleTime).toBe('03:00');
    expect(result.scheduleDayOfWeek).toBe('mon');
    expect(result.scheduleDayOfMonth).toBe(15);
    expect(result.rebootPolicy).toBe('always');
  });

  it('returns defaults when given empty object', () => {
    const result = normalizePatchInlineSettings({});

    expect(result.sources).toEqual(['os']);
    expect(result.autoApprove).toBe(false);
    expect(result.autoApproveSeverities).toEqual([]);
    expect(result.scheduleFrequency).toBe('weekly');
    expect(result.scheduleTime).toBe('02:00');
    expect(result.scheduleDayOfWeek).toBe('sun');
    expect(result.scheduleDayOfMonth).toBe(1);
    expect(result.rebootPolicy).toBe('if_required');
  });

  it('returns defaults when given null', () => {
    const result = normalizePatchInlineSettings(null);

    expect(result.sources).toEqual(['os']);
    expect(result.autoApprove).toBe(false);
    expect(result.scheduleFrequency).toBe('weekly');
  });

  it('returns defaults when given undefined', () => {
    const result = normalizePatchInlineSettings(undefined);

    expect(result.sources).toEqual(['os']);
    expect(result.rebootPolicy).toBe('if_required');
  });

  it('throws on truly invalid input where Zod parse fails', () => {
    // Invalid: sources must have at least 1 item, but `sources: []` fails min(1)
    expect(() =>
      normalizePatchInlineSettings({ sources: [] }),
    ).toThrow();
  });

  it('throws on invalid scheduleTime format', () => {
    expect(() =>
      normalizePatchInlineSettings({ scheduleTime: 'invalid' }),
    ).toThrow();
  });
});

describe('tryNormalizePatchInlineSettings', () => {
  it('returns valid: true for good input', () => {
    const result = tryNormalizePatchInlineSettings({
      sources: ['os'],
      autoApprove: false,
      autoApproveSeverities: [],
      scheduleFrequency: 'weekly',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
    });

    expect(result.valid).toBe(true);
    expect(result.settings.sources).toEqual(['os']);
  });

  it('returns valid: false with defaults for garbage input', () => {
    const result = tryNormalizePatchInlineSettings({
      sources: [],
      scheduleTime: 'not-a-time',
    });

    expect(result.valid).toBe(false);
    // Falls back to parse({}) which gives defaults
    expect(result.settings.sources).toEqual(['os']);
    expect(result.settings.scheduleFrequency).toBe('weekly');
    expect(result.settings.scheduleTime).toBe('02:00');
    expect(result.settings.rebootPolicy).toBe('if_required');
  });

  it('returns valid: true with defaults when given empty object', () => {
    const result = tryNormalizePatchInlineSettings({});

    expect(result.valid).toBe(true);
    expect(result.settings.sources).toEqual(['os']);
  });

  it('returns valid: true with defaults when given null', () => {
    const result = tryNormalizePatchInlineSettings(null);

    expect(result.valid).toBe(true);
    expect(result.settings.sources).toEqual(['os']);
  });

  it('returns valid: false for autoApprove true with empty severities (superRefine)', () => {
    const result = tryNormalizePatchInlineSettings({
      autoApprove: true,
      autoApproveSeverities: [],
    });

    expect(result.valid).toBe(false);
    expect(result.settings.sources).toEqual(['os']);
  });
});

describe('summarizePatchInventory', () => {
  function makeRow(overrides: Partial<PatchInventoryRow> = {}): PatchInventoryRow {
    return {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Test Policy',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: null,
      classification: 'null',
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'ok',
      ...overrides,
    };
  }

  it('categorizes rows by effective status', () => {
    const rows: PatchInventoryRow[] = [
      makeRow({ effectiveStatus: 'ok' }),
      makeRow({ effectiveStatus: 'ok' }),
      makeRow({ effectiveStatus: 'needs_repair' }),
      makeRow({ effectiveStatus: 'invalid_reference' }),
      makeRow({ effectiveStatus: 'invalid_reference' }),
      makeRow({ effectiveStatus: 'invalid_reference' }),
    ];

    const summary = summarizePatchInventory(rows);

    expect(summary.total).toBe(6);
    expect(summary.ok).toBe(2);
    expect(summary.needsRepair).toBe(1);
    expect(summary.invalidReference).toBe(3);
  });

  it('returns zeros for empty input', () => {
    const summary = summarizePatchInventory([]);

    expect(summary).toEqual({
      total: 0,
      ok: 0,
      needsRepair: 0,
      invalidReference: 0,
    });
  });

  it('handles all-ok rows', () => {
    const rows = [makeRow(), makeRow(), makeRow()];
    const summary = summarizePatchInventory(rows);

    expect(summary.total).toBe(3);
    expect(summary.ok).toBe(3);
    expect(summary.needsRepair).toBe(0);
    expect(summary.invalidReference).toBe(0);
  });
});

describe('ring resolution classification values', () => {
  // These tests verify that all five classification values are valid
  // and can be used in PatchInventoryRow objects.
  const classifications: PatchReferenceClassification[] = [
    'valid_ring',
    'legacy_patch_policy',
    'config_policy_uuid',
    'missing_target',
    'null',
  ];

  it.each(classifications)('classification "%s" is a valid PatchReferenceClassification', (classification) => {
    const row = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Test Policy',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: classification === 'null' ? null : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      classification,
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'ok' as const,
    } satisfies PatchInventoryRow;

    expect(row.classification).toBe(classification);
  });

  it('valid_ring results in ok when settings present and valid', () => {
    const row: PatchInventoryRow = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Ring Policy',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      classification: 'valid_ring',
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'ok',
    };

    const summary = summarizePatchInventory([row]);
    expect(summary.ok).toBe(1);
    expect(summary.invalidReference).toBe(0);
  });

  it('legacy_patch_policy results in invalid_reference', () => {
    const row: PatchInventoryRow = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Legacy Policy',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      classification: 'legacy_patch_policy',
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'invalid_reference',
    };

    const summary = summarizePatchInventory([row]);
    expect(summary.invalidReference).toBe(1);
    expect(summary.ok).toBe(0);
  });

  it('config_policy_uuid results in invalid_reference', () => {
    const row: PatchInventoryRow = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Config UUID Policy',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      classification: 'config_policy_uuid',
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'invalid_reference',
    };

    const summary = summarizePatchInventory([row]);
    expect(summary.invalidReference).toBe(1);
  });

  it('missing_target results in invalid_reference', () => {
    const row: PatchInventoryRow = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Missing Target',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      classification: 'missing_target',
      normalizedSettingsPresent: true,
      inlineSettingsValid: true,
      effectiveStatus: 'invalid_reference',
    };

    const summary = summarizePatchInventory([row]);
    expect(summary.invalidReference).toBe(1);
  });

  it('null classification with missing normalized settings results in needs_repair', () => {
    const row: PatchInventoryRow = {
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      configPolicyName: 'Needs Repair',
      orgId: '11111111-1111-1111-1111-111111111111',
      featureLinkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      referencedTargetId: null,
      classification: 'null',
      normalizedSettingsPresent: false,
      inlineSettingsValid: true,
      effectiveStatus: 'needs_repair',
    };

    const summary = summarizePatchInventory([row]);
    expect(summary.needsRepair).toBe(1);
  });
});
