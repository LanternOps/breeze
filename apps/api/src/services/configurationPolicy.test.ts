import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { addFeatureLink, updateFeatureLink, listFeatureLinks, pamInlineSettingsSchema } from './configurationPolicy';
import { db } from '../db';

// Chain for `db.select().from(...).where(...)` awaited directly (links query)
function selectWhereRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

// Chain for `db.select().from(...).where(...).limit(...)` (normalized settings query)
function selectLimitRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

const PATCH_INPUT = {
  sources: ['os', 'third_party'],
  autoApprove: true,
  autoApproveSeverities: ['critical'],
  autoApproveDeferralDays: 7,
  apps: [
    { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    { source: 'third_party', packageId: '7zip.7zip', action: 'pin', pinnedVersion: '23.01' },
  ],
  scheduleFrequency: 'daily',
  scheduleTime: '03:30',
  scheduleDayOfWeek: 'tue',
  scheduleDayOfMonth: 5,
  rebootPolicy: 'never',
};

describe('patch feature link round-trip (apps + autoApproveDeferralDays)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists apps and autoApproveDeferralDays in JSONB on save and returns them from listFeatureLinks', async () => {
    // --- Save path: addFeatureLink ---
    let storedJsonb: any;
    let normalizedRowValues: any;
    let insertCall = 0;

    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            // feature link insert — captures what lands in the inline_settings JSONB
            storedJsonb = v.inlineSettings;
            return {
              returning: vi.fn(() =>
                Promise.resolve([
                  {
                    id: 'link-1',
                    configPolicyId: 'policy-1',
                    featureType: 'patch',
                    featurePolicyId: null,
                    inlineSettings: v.inlineSettings,
                  },
                ])
              ),
            };
          }
          // config_policy_patch_settings insert (decomposeInlineSettings)
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'patch', null, PATCH_INPUT);

    // The JSONB mirror must keep the JSON-only fields...
    expect(storedJsonb.apps).toEqual(PATCH_INPUT.apps);
    expect(storedJsonb.autoApproveDeferralDays).toBe(7);
    // ...while the normalized table (which has no columns for them) does not get them
    expect(normalizedRowValues.featureLinkId).toBe('link-1');
    expect(normalizedRowValues.apps).toBeUndefined();
    expect(normalizedRowValues.autoApproveDeferralDays).toBeUndefined();

    // --- Read path: listFeatureLinks, fed exactly what the save wrote ---
    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any) // links query
      .mockReturnValueOnce(
        selectLimitRows([
          {
            id: 'ps-1',
            featureLinkId: 'link-1',
            sources: normalizedRowValues.sources,
            autoApprove: normalizedRowValues.autoApprove,
            autoApproveSeverities: normalizedRowValues.autoApproveSeverities,
            scheduleFrequency: normalizedRowValues.scheduleFrequency,
            scheduleTime: normalizedRowValues.scheduleTime,
            scheduleDayOfWeek: normalizedRowValues.scheduleDayOfWeek,
            scheduleDayOfMonth: normalizedRowValues.scheduleDayOfMonth,
            rebootPolicy: normalizedRowValues.rebootPolicy,
          },
        ]) as any
      ); // assembleInlineSettings patch query

    const result = await listFeatureLinks('policy-1');
    expect(result).toHaveLength(1);
    const settings = result[0]!.inlineSettings as any;

    // THE BUG: these two came back as [] / 0 before the merge fix
    expect(settings.apps).toEqual(PATCH_INPUT.apps);
    expect(settings.autoApproveDeferralDays).toBe(7);

    // Relational fields still come from the normalized row
    expect(settings.sources).toEqual(['os', 'third_party']);
    expect(settings.autoApprove).toBe(true);
    expect(settings.autoApproveSeverities).toEqual(['critical']);
    expect(settings.scheduleFrequency).toBe('daily');
    expect(settings.scheduleTime).toBe('03:30');
    expect(settings.rebootPolicy).toBe('never');
  });

  it('updateFeatureLink keeps apps and autoApproveDeferralDays in the JSONB write', async () => {
    let setValues: any;
    const tx = {
      select: vi.fn(() =>
        selectLimitRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: {},
          },
        ])
      ),
      update: vi.fn(() => ({
        set: vi.fn((v: any) => {
          setValues = v;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ id: 'link-1' }])),
            })),
          };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const updated = await updateFeatureLink('link-1', { inlineSettings: PATCH_INPUT }, 'policy-1');

    expect(updated).not.toBeNull();
    expect(setValues.inlineSettings.apps).toEqual(PATCH_INPUT.apps);
    expect(setValues.inlineSettings.autoApproveDeferralDays).toBe(7);
  });

  it('merges JSON-only fields from stored JSONB even when the normalized row wins', async () => {
    // Mirrors loadPolicyLocalPatchConfig behavior in configPolicyPatching.ts
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: {
              sources: ['third_party'],
              autoApprove: true,
              autoApproveSeverities: ['critical'],
              autoApproveDeferralDays: 5,
              apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
            },
          },
        ]) as any
      )
      .mockReturnValueOnce(
        selectLimitRows([
          {
            id: 'ps-1',
            featureLinkId: 'link-1',
            sources: ['os'],
            autoApprove: false,
            autoApproveSeverities: [],
            scheduleFrequency: 'daily',
            scheduleTime: '03:00',
            scheduleDayOfWeek: 'mon',
            scheduleDayOfMonth: 10,
            rebootPolicy: 'if_required',
          },
        ]) as any
      );

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as any;

    // Normalized row wins for relational fields
    expect(settings.sources).toEqual(['os']);
    expect(settings.autoApprove).toBe(false);
    expect(settings.scheduleDayOfMonth).toBe(10);
    // JSON-only fields survive from the stored JSONB
    expect(settings.autoApproveDeferralDays).toBe(5);
    expect(settings.apps).toEqual([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    ]);
  });

  it('falls back to defaults for JSON-only fields when stored JSONB is malformed (no throw)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: {
              sources: [], // violates min(1)
              scheduleTime: 'not-a-time',
              apps: 'garbage-not-an-array',
              autoApproveDeferralDays: 999, // out of range
            },
          },
        ]) as any
      )
      .mockReturnValueOnce(
        selectLimitRows([
          {
            id: 'ps-1',
            featureLinkId: 'link-1',
            sources: ['os'],
            autoApprove: false,
            autoApproveSeverities: [],
            scheduleFrequency: 'weekly',
            scheduleTime: '02:00',
            scheduleDayOfWeek: 'sun',
            scheduleDayOfMonth: 1,
            rebootPolicy: 'if_required',
          },
        ]) as any
      );

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as any;

    // Merged fields fall back to schema defaults without throwing
    expect(settings.apps).toEqual([]);
    expect(settings.autoApproveDeferralDays).toBe(0);
    // Normalized row still supplies the relational fields
    expect(settings.sources).toEqual(['os']);
    expect(settings.scheduleTime).toBe('02:00');
  });

  it('falls back to the stored JSONB (including apps) when no normalized row exists', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: PATCH_INPUT,
          },
        ]) as any
      )
      .mockReturnValueOnce(selectLimitRows([]) as any); // no config_policy_patch_settings row

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as any;

    expect(settings.apps).toEqual(PATCH_INPUT.apps);
    expect(settings.autoApproveDeferralDays).toBe(7);
    expect(settings.sources).toEqual(['os', 'third_party']);
  });

  it('does not throw when no normalized row exists and stored JSONB is malformed', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            inlineSettings: { sources: [], scheduleTime: 'nope' },
          },
        ]) as any
      )
      .mockReturnValueOnce(selectLimitRows([]) as any);

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as any;

    expect(settings.sources).toEqual(['os']); // schema defaults
    expect(settings.apps).toEqual([]);
    expect(settings.autoApproveDeferralDays).toBe(0);
  });

  it('leaves non-patch feature links untouched (raw JSONB passthrough)', async () => {
    const helperSettings = { someHelperFlag: true };
    vi.mocked(db.select).mockReturnValueOnce(
      selectWhereRows([
        {
          id: 'link-2',
          configPolicyId: 'policy-1',
          featureType: 'helper',
          featurePolicyId: null,
          inlineSettings: helperSettings,
        },
      ]) as any
    );

    const result = await listFeatureLinks('policy-1');
    expect(result[0]!.inlineSettings).toEqual(helperSettings);
  });
});

// ============================================================
// pamInlineSettingsSchema — unit tests for the exported schema
// ============================================================

describe('pamInlineSettingsSchema', () => {
  it('accepts {} (all fields optional)', () => {
    expect(() => pamInlineSettingsSchema.parse({})).not.toThrow();
  });

  it('accepts { uacInterceptionEnabled: true }', () => {
    const result = pamInlineSettingsSchema.parse({ uacInterceptionEnabled: true });
    expect(result.uacInterceptionEnabled).toBe(true);
  });

  it('accepts { uacInterceptionEnabled: false }', () => {
    const result = pamInlineSettingsSchema.parse({ uacInterceptionEnabled: false });
    expect(result.uacInterceptionEnabled).toBe(false);
  });

  it('rejects uacInterceptionEnabled as string "false"', () => {
    expect(() => pamInlineSettingsSchema.parse({ uacInterceptionEnabled: 'false' })).toThrow();
  });

  it('rejects uacInterceptionEnabled as number 0', () => {
    expect(() => pamInlineSettingsSchema.parse({ uacInterceptionEnabled: 0 })).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => pamInlineSettingsSchema.parse({ uacInterceptionEnabled: true, extra: 'nope' })).toThrow();
  });
});

// ============================================================
// addFeatureLink — pam inlineSettings service-layer validation
// ============================================================

describe('addFeatureLink — pam inlineSettings service-layer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ZodError before entering the transaction when uacInterceptionEnabled is string "false"', async () => {
    // transaction should never be called — validation is pre-transaction
    await expect(
      addFeatureLink('policy-1', 'pam', null, { uacInterceptionEnabled: 'false' })
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('throws ZodError for unknown extra key on pam inlineSettings', async () => {
    await expect(
      addFeatureLink('policy-1', 'pam', null, { uacInterceptionEnabled: true, rogue: 'x' })
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('does not throw and enters the transaction for valid pam inlineSettings { uacInterceptionEnabled: false }', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
              { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: { uacInterceptionEnabled: false } },
            ])
          ),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'pam', null, { uacInterceptionEnabled: false });
    expect(link).toBeDefined();
    expect(vi.mocked(db.transaction)).toHaveBeenCalledOnce();
  });

  it('does not throw and enters the transaction for valid pam inlineSettings {}', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
              { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: {} },
            ])
          ),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'pam', null, {});
    expect(link).toBeDefined();
  });

  it('skips pam validation when inlineSettings is null/undefined', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
              { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: null },
            ])
          ),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    // Should not throw — pam validation is skipped for null/undefined inlineSettings
    await expect(addFeatureLink('policy-1', 'pam', null, null)).resolves.toBeDefined();
    await expect(addFeatureLink('policy-1', 'pam', null, undefined)).resolves.toBeDefined();
  });
});

// ============================================================
// updateFeatureLink — pam inlineSettings service-layer validation
// ============================================================

describe('updateFeatureLink — pam inlineSettings service-layer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTxWithExistingPamLink() {
    const tx: any = {
      select: vi.fn(() => selectLimitRows([
        { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: {} },
      ])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'link-pam', featureType: 'pam' }])),
          })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

  it('throws ZodError when updating pam link with uacInterceptionEnabled as string "false"', async () => {
    makeTxWithExistingPamLink();
    await expect(
      updateFeatureLink('link-pam', { inlineSettings: { uacInterceptionEnabled: 'false' } }, 'policy-1')
    ).rejects.toThrow();
  });

  it('throws ZodError when updating pam link with unknown extra key', async () => {
    makeTxWithExistingPamLink();
    await expect(
      updateFeatureLink('link-pam', { inlineSettings: { rogue: true } }, 'policy-1')
    ).rejects.toThrow();
  });

  it('succeeds when updating pam link with valid inlineSettings { uacInterceptionEnabled: false }', async () => {
    makeTxWithExistingPamLink();
    const result = await updateFeatureLink('link-pam', { inlineSettings: { uacInterceptionEnabled: false } }, 'policy-1');
    expect(result).not.toBeNull();
  });

  it('succeeds when updating pam link with inlineSettings: null (clear settings)', async () => {
    makeTxWithExistingPamLink();
    // null inlineSettings means "clear" — pam validation is skipped
    const result = await updateFeatureLink('link-pam', { inlineSettings: null }, 'policy-1');
    expect(result).not.toBeNull();
  });
});
