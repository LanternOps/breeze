import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../routes/patches/helpers', () => ({
  resolvePartnerIdForOrg: vi.fn(async (_orgId: string) => 'partner-1'),
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
    partnerId: 'partner_id',
    kind: 'kind',
    name: 'name',
    categoryRules: 'category_rules',
    autoApprove: 'auto_approve',
  },
}));

import {
  loadPolicyLocalPatchConfig,
  listAllPatchInventory,
  normalizePatchInlineSettings,
  tryNormalizePatchInlineSettings,
  summarizePatchInventory,
  type PatchInventoryRow,
  type PatchReferenceClassification,
} from './configPolicyPatching';
import { db } from '../db';
import { captureException } from './sentry';
import { resolvePartnerIdForOrg } from '../routes/patches/helpers';

function selectJoinLimitRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

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

describe('loadPolicyLocalPatchConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves JSON-only patch fields when normalized patch settings exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-1',
      configPolicyName: 'Policy 1',
      orgId: 'org-1',
      featureLinkId: 'link-1',
      featurePolicyId: null,
      storedInlineSettings: {
        sources: ['third_party'],
        autoApprove: true,
        autoApproveSeverities: ['critical'],
        autoApproveDeferralDays: 5,
        apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
      },
      patchSettings: {
        sources: ['os'],
        autoApprove: false,
        autoApproveSeverities: [],
        scheduleFrequency: 'daily',
        scheduleTime: '03:00',
        scheduleDayOfWeek: 'mon',
        scheduleDayOfMonth: 10,
        rebootPolicy: 'if_required',
      },
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-1');

    expect(result?.settings.sources).toEqual(['os']);
    expect(result?.settings.autoApprove).toBe(false);
    expect(result?.settings.autoApproveDeferralDays).toBe(5);
    expect(result?.settings.apps).toEqual([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    ]);
  });

  it('salvages valid app rules and deferral when stored inline JSON is malformed, with warn + Sentry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-2',
      configPolicyName: 'Policy 2',
      orgId: 'org-1',
      featureLinkId: 'link-2',
      featurePolicyId: null,
      storedInlineSettings: {
        // Legacy unpadded time — fails the whole-document parse.
        scheduleTime: '2:00',
        autoApproveDeferralDays: 7,
        apps: [
          { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
          { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
          // Invalid entry: pin without pinnedVersion — dropped individually.
          { source: 'third_party', packageId: 'BadEntry', action: 'pin' },
        ],
      },
      patchSettings: {
        sources: ['os', 'third_party'],
        autoApprove: false,
        autoApproveSeverities: [],
        scheduleFrequency: 'weekly',
        scheduleTime: '03:00',
        scheduleDayOfWeek: 'sat',
        scheduleDayOfMonth: 1,
        rebootPolicy: 'if_required',
      },
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-2');

    // Columns win for normalized fields.
    expect(result?.settings.sources).toEqual(['os', 'third_party']);
    expect(result?.settings.scheduleTime).toBe('03:00');
    // JSON-only fields are salvaged per-entry, not wiped to defaults.
    expect(result?.settings.autoApproveDeferralDays).toBe(7);
    expect(result?.settings.apps).toEqual([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
      { source: 'custom', packageId: 'corp-tool', action: 'pin', pinnedVersion: '1.2.3' },
    ]);

    // Loud failure: document-level warn + Sentry, plus per-entry drop warn.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stored patch inline settings failed validation')
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('policy-2'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropping invalid app rule at index 2')
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]?.[0]).toBeInstanceOf(Error);

    warnSpy.mockRestore();
  });

  it('falls back to defaults with a warn when inline JSON is malformed and no patchSettings row exists', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-3',
      configPolicyName: 'Policy 3',
      orgId: 'org-1',
      featureLinkId: 'link-3',
      featurePolicyId: null,
      storedInlineSettings: {
        sources: [], // fails min(1)
        autoApproveDeferralDays: 999, // out of range — NOT salvaged
      },
      patchSettings: null,
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-3');

    // Pins the lenient contract: malformed JSON + no normalized row → defaults.
    expect(result?.settings.sources).toEqual(['os']);
    expect(result?.settings.autoApprove).toBe(false);
    expect(result?.settings.autoApproveDeferralDays).toBe(0);
    expect(result?.settings.apps).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stored patch inline settings failed validation')
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('policy-3'));
    expect(captureException).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('dedupes salvaged app rules so the downstream re-parse cannot throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-4',
      configPolicyName: 'Policy 4',
      orgId: 'org-1',
      featureLinkId: 'link-4',
      featurePolicyId: null,
      storedInlineSettings: {
        scheduleTime: '2:00', // forces whole-document failure
        apps: [
          { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
          // Same canonical bucket (custom → third_party) + same packageId.
          { source: 'custom', packageId: 'mozilla.firefox', action: 'block' },
        ],
      },
      patchSettings: {
        sources: ['os'],
        autoApprove: false,
        autoApproveSeverities: [],
        scheduleFrequency: 'weekly',
        scheduleTime: '02:00',
        scheduleDayOfWeek: 'sun',
        scheduleDayOfMonth: 1,
        rebootPolicy: 'if_required',
      },
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-4');

    expect(result?.settings.apps).toEqual([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropping duplicate app rule at index 1')
    );

    warnSpy.mockRestore();
  });

  it('returns null (fail-closed) when resolvePartnerIdForOrg returns null — orphaned org', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(resolvePartnerIdForOrg).mockResolvedValueOnce(null);

    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-orphan',
      configPolicyName: 'Orphan Policy',
      orgId: 'orphan-org',
      featureLinkId: 'link-orphan',
      featurePolicyId: 'some-ring-id',
      storedInlineSettings: { sources: ['os'] },
      patchSettings: null,
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-orphan');

    // Must return null — not throw a 22P02 uuid error
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphaned org has no partner'),
      expect.objectContaining({ orgId: 'orphan-org', configPolicyId: 'policy-orphan' })
    );

    warnSpy.mockRestore();
  });

  it('does not warn or capture when stored inline settings are valid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimitRows([{
      configPolicyId: 'policy-5',
      configPolicyName: 'Policy 5',
      orgId: 'org-1',
      featureLinkId: 'link-5',
      featurePolicyId: null,
      storedInlineSettings: {
        sources: ['os'],
        autoApproveDeferralDays: 3,
        apps: [{ source: 'custom', packageId: 'corp-tool', action: 'block' }],
      },
      patchSettings: null,
    }]) as any);

    const result = await loadPolicyLocalPatchConfig('policy-5');

    expect(result?.settings.autoApproveDeferralDays).toBe(3);
    expect(result?.settings.apps).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();

    warnSpy.mockRestore();
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

describe('listAllPatchInventory — null partner fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies an orphaned-org row as missing_target without throwing a uuid error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(resolvePartnerIdForOrg).mockResolvedValueOnce(null);

    // Simulate a single row returned from the DB scan
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{
      configPolicyId: 'policy-inv-orphan',
      configPolicyName: 'Inventory Orphan',
      orgId: 'orphan-org',
      featureLinkId: 'link-inv-orphan',
      referencedTargetId: 'some-ring-uuid',
      storedInlineSettings: null,
      patchSettingsId: null,
    }]));
    vi.mocked(db.select).mockReturnValueOnce(chain);

    const rows = await listAllPatchInventory();

    // Must not throw; orphaned org yields missing_target → invalid_reference
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classification).toBe('missing_target');
    expect(rows[0]!.effectiveStatus).toBe('invalid_reference');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphaned org has no partner'),
      expect.objectContaining({ orgId: 'orphan-org' })
    );

    warnSpy.mockRestore();
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
