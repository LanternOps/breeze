import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveOwnedAutomationReferencesMock } = vi.hoisted(() => ({
  resolveOwnedAutomationReferencesMock: vi.fn(),
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: resolveOwnedAutomationReferencesMock,
}));

// Keep this service suite focused on its storage ordering. Loading the full
// runtime through configurationPolicy's lazy import can exceed Vitest's
// per-case timeout when this file runs with the runtime suites.
vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((actions: unknown) => {
    if (!Array.isArray(actions)) throw new Error('actions must be an array');
    return actions;
  }),
  resolveAutomationReferencesForOwner: vi.fn(
    (tx: unknown, owner: unknown, actions: unknown) =>
      resolveOwnedAutomationReferencesMock(tx, owner, [], actions, []),
  ),
}));

const { resolvePatchPolicyReferenceMock, loadConfigPolicyPartnerIdMock } = vi.hoisted(() => ({
  resolvePatchPolicyReferenceMock: vi.fn(),
  loadConfigPolicyPartnerIdMock: vi.fn(),
}));
vi.mock('./configPolicyPatching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./configPolicyPatching')>()),
  resolvePatchPolicyReference: resolvePatchPolicyReferenceMock,
  loadConfigPolicyPartnerId: loadConfigPolicyPartnerIdMock,
}));

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
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

import {
  addFeatureLink,
  assignPolicy,
  updateFeatureLink,
  listConfigPolicies,
  listFeatureLinks,
  pamInlineSettingsSchema,
  validateFeaturePolicyExists,
  canManagePartnerWidePolicies,
  updateConfigPolicy,
  deleteConfigPolicy,
  PartnerWideWriteDeniedError,
} from './configurationPolicy';
import { db } from '../db';
import {
  configPolicyFeatureLinks,
} from '../db/schema';

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

describe('feature link reserved export marker service backstop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'patch', 'security', 'software_policy', 'peripheral_control',
    'warranty', 'helper', 'vulnerability',
  ] as const)('rejects marker injection before add transaction for %s', async (featureType) => {
    await expect(addFeatureLink(
      'policy-1',
      featureType,
      null,
      { nested: { __breezePatchInlineMirror: 'attacker-value' } },
    )).rejects.toThrow(/reserved/i);
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('rejects marker injection before update transaction for the AI/service path', async () => {
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { nested: [{ __breezePatchInlineMirror: 'attacker-value' }] },
    }, 'policy-1')).rejects.toThrow(/reserved/i);
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });
});

describe('automation feature link reference authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOwnedAutomationReferencesMock.mockResolvedValue({
      scriptsById: new Map(),
      softwareCatalogsById: new Map(),
      softwareVersionsByCatalogId: new Map(),
      notificationChannelsById: new Map(),
    });
  });

  it('rejects a foreign script before storing either the feature link or normalized automation', async () => {
    const insert = vi.fn()
      .mockReturnValueOnce({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'link-foreign' }]),
          })),
        })),
      })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue([]) });
    const tx = {
      select: vi.fn(() => selectLimitRows([{ orgId: null, partnerId: 'partner-a' }])),
      insert,
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    resolveOwnedAutomationReferencesMock.mockRejectedValueOnce(
      Object.assign(new Error('Unknown or unauthorized automation reference'), {
        code: 'unknown_or_unauthorized_reference',
      }),
    );

    await expect(addFeatureLink('policy-1', 'automation', null, {
      items: [{
        name: 'Foreign script',
        triggerType: 'manual',
        actions: [{
          type: 'run_script',
          scriptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }],
      }],
    })).rejects.toMatchObject({ code: 'unknown_or_unauthorized_reference' });

    expect(insert).toHaveBeenCalledTimes(0);
  });
});

const PATCH_INPUT_NO_APPROVAL = {
  ...PATCH_INPUT,
  autoApprove: false,
  autoApproveSeverities: [],
  apps: [],
};

describe('patch feature link writes reject approval-rule edits (#8186)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function txWithStoredPatchLink(storedInline: unknown, featurePolicyId: string | null = null) {
    const set = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'link-1' }])) })),
    }));
    const update = vi.fn(() => ({ set }));
    const tx: any = {
      select: vi.fn(() => selectLimitRows([
        { id: 'link-1', configPolicyId: 'policy-1', featureType: 'patch', featurePolicyId, inlineSettings: storedInline },
      ])),
      update,
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
      set,
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

  /** The link JSONB the update wrote (the first `set` call carrying inlineSettings). */
  function writtenInline(tx: any): Record<string, unknown> | undefined {
    const call = tx.set.mock.calls.find((args: any[]) => args[0] && 'inlineSettings' in args[0]);
    return call?.[0].inlineSettings;
  }

  const moved = { status: 400, code: 'APPROVAL_RULES_MOVED_TO_RING', message: expect.stringContaining('Update Ring') };
  // #8678: repairing a broken ring reference onto a ring that lacks the link's
  // legacy rules is a different refusal than a stale tab editing them.
  const ringLacksRules = { status: 400, code: 'RING_LACKS_POLICY_APP_RULES', message: expect.stringContaining('Update Ring') };

  it('rejects an ADDED app rule with APPROVAL_RULES_MOVED_TO_RING and writes nothing', async () => {
    const tx = txWithStoredPatchLink(PATCH_INPUT_NO_APPROVAL);
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { ...PATCH_INPUT_NO_APPROVAL, apps: [{ source: 'third_party', packageId: 'Zoom.Zoom', action: 'block' }] },
    }, 'policy-1')).rejects.toMatchObject(moved);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('rejects a REMOVED or CHANGED app rule', async () => {
    txWithStoredPatchLink(PATCH_INPUT);
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { ...PATCH_INPUT, apps: [PATCH_INPUT.apps[0]] },
    }, 'policy-1')).rejects.toMatchObject(moved);
    txWithStoredPatchLink(PATCH_INPUT);
    await expect(updateFeatureLink('link-1', {
      inlineSettings: {
        ...PATCH_INPUT,
        apps: [PATCH_INPUT.apps[0], { source: 'third_party', packageId: '7zip.7zip', action: 'pin', pinnedVersion: '24.00' }],
      },
    }, 'policy-1')).rejects.toMatchObject(moved);
  });

  it('accepts the stored list re-sent in another order and case (a stale tab saving other fields)', async () => {
    const tx = txWithStoredPatchLink(PATCH_INPUT);
    const updated = await updateFeatureLink('link-1', {
      inlineSettings: {
        ...PATCH_INPUT,
        scheduleTime: '04:00',
        apps: [
          { source: 'custom', packageId: '7ZIP.7zip', action: 'pin', pinnedVersion: '23.01' },
          { source: 'third_party', packageId: 'mozilla.firefox', action: 'block', displayName: 'Firefox' },
        ],
      },
    }, 'policy-1');
    expect(updated).not.toBeNull();
    expect(tx.update).toHaveBeenCalled();
  });

  it('accepts an update that omits apps and autoApprove entirely', async () => {
    txWithStoredPatchLink(PATCH_INPUT);
    const { apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, ...rest } = PATCH_INPUT;
    await expect(updateFeatureLink('link-1', { inlineSettings: rest }, 'policy-1')).resolves.not.toBeNull();
  });

  // #8671: an update that does not send the legacy approval keys must keep the
  // stored values (W04 strips them), not let schema defaults wipe them.
  it('preserves the stored legacy apps / autoApprove* when the update omits them', async () => {
    const tx = txWithStoredPatchLink(PATCH_INPUT);
    const {
      apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, autoApproveDeferralDays: _def, ...rest
    } = PATCH_INPUT;
    await updateFeatureLink('link-1', { inlineSettings: { ...rest, scheduleTime: '05:00' } }, 'policy-1');
    expect(writtenInline(tx)).toMatchObject({
      scheduleTime: '05:00',
      apps: PATCH_INPUT.apps,
      autoApprove: true,
      autoApproveSeverities: ['critical'],
      autoApproveDeferralDays: 7,
    });
  });

  it('preserves the relational autoApprove the read path serves when the update omits it', async () => {
    const tx = txWithStoredPatchLink(PATCH_INPUT_NO_APPROVAL);
    tx.select
      .mockImplementationOnce(() => selectLimitRows([
        { id: 'link-1', configPolicyId: 'policy-1', featureType: 'patch', featurePolicyId: null, inlineSettings: PATCH_INPUT_NO_APPROVAL },
      ]))
      .mockImplementationOnce(() => selectLimitRows([{ autoApprove: true, autoApproveSeverities: ['critical'] }]));
    const { apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, ...rest } = PATCH_INPUT_NO_APPROVAL;
    await updateFeatureLink('link-1', { inlineSettings: rest }, 'policy-1');
    expect(writtenInline(tx)).toMatchObject({ autoApprove: true, autoApproveSeverities: ['critical'], apps: [] });
  });

  it('salvages a stored apps list whose document does not validate instead of failing the write', async () => {
    const tx = txWithStoredPatchLink({ ...PATCH_INPUT, scheduleTime: '2:00' });
    const { apps: _apps, ...rest } = PATCH_INPUT;
    await expect(updateFeatureLink('link-1', { inlineSettings: rest }, 'policy-1')).resolves.not.toBeNull();
    expect(writtenInline(tx)).toMatchObject({ apps: PATCH_INPUT.apps, scheduleTime: '03:30' });
  });

  it('a ring change without apps keeps the stored legacy apps on the link', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    resolvePatchPolicyReferenceMock.mockResolvedValue(ring(ENFORCED_RULES));
    const tx = txWithStoredPatchLink(PATCH_INPUT, 'ring-1');
    const { apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, ...rest } = PATCH_INPUT;
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2', inlineSettings: rest }, 'policy-1'))
      .resolves.not.toBeNull();
    expect(writtenInline(tx)).toMatchObject({ apps: PATCH_INPUT.apps });
  });

  it('a Patch-tab ring change (settings sent, apps omitted) off an invalid ring still needs a target that carries the legacy rules', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    const { apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, ...rest } = PATCH_INPUT;
    resolvePatchPolicyReferenceMock
      .mockResolvedValueOnce(ring([], false, null))
      .mockResolvedValueOnce(ring([]));
    const rejected = txWithStoredPatchLink(PATCH_INPUT, 'gone-ring');
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2', inlineSettings: rest }, 'policy-1'))
      .rejects.toMatchObject(ringLacksRules);
    expect(rejected.update).not.toHaveBeenCalled();

    resolvePatchPolicyReferenceMock
      .mockResolvedValueOnce(ring([], false, null))
      .mockResolvedValueOnce(ring(ENFORCED_RULES));
    const accepted = txWithStoredPatchLink(PATCH_INPUT, 'gone-ring');
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2', inlineSettings: rest }, 'policy-1'))
      .resolves.not.toBeNull();
    expect(writtenInline(accepted)).toMatchObject({ apps: PATCH_INPUT.apps });
  });

  it('drops (and warns about) a stored autoApprove that has no valid severity instead of failing an unrelated save', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tx = txWithStoredPatchLink({ ...PATCH_INPUT_NO_APPROVAL, autoApprove: true, autoApproveSeverities: [] });
    const { apps: _apps, autoApprove: _aa, autoApproveSeverities: _sev, autoApproveDeferralDays: _d, ...rest } = PATCH_INPUT_NO_APPROVAL;
    await expect(updateFeatureLink('link-1', { inlineSettings: rest }, 'policy-1')).resolves.not.toBeNull();
    expect(writtenInline(tx)).toMatchObject({ autoApprove: false, autoApproveSeverities: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/autoApprove.*link-1|link-1.*autoApprove/));
    warn.mockRestore();
  });

  it('an explicitly sent apps list is written as sent (no merge over it)', async () => {
    const tx = txWithStoredPatchLink({ ...PATCH_INPUT_NO_APPROVAL, scheduleTime: '2:00', apps: PATCH_INPUT.apps });
    await updateFeatureLink('link-1', { inlineSettings: PATCH_INPUT_NO_APPROVAL }, 'policy-1');
    expect(writtenInline(tx)).toMatchObject({ apps: [] });
  });

  it('accepts the empty list a client loaded from a stored document that does not validate', async () => {
    // The read path hands such a document back with apps: [] (schema defaults).
    txWithStoredPatchLink({ ...PATCH_INPUT_NO_APPROVAL, scheduleTime: '2:00', apps: PATCH_INPUT.apps });
    await expect(updateFeatureLink('link-1', { inlineSettings: PATCH_INPUT_NO_APPROVAL }, 'policy-1'))
      .resolves.not.toBeNull();
  });

  it('rejects newly setting autoApprove: true, accepts it when already stored', async () => {
    txWithStoredPatchLink(PATCH_INPUT_NO_APPROVAL);
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { ...PATCH_INPUT_NO_APPROVAL, autoApprove: true, autoApproveSeverities: ['critical'] },
    }, 'policy-1')).rejects.toMatchObject(moved);

    txWithStoredPatchLink({ ...PATCH_INPUT_NO_APPROVAL, autoApprove: true, autoApproveSeverities: ['critical'] });
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { ...PATCH_INPUT_NO_APPROVAL, autoApprove: true, autoApproveSeverities: ['critical'] },
    }, 'policy-1')).resolves.not.toBeNull();
  });

  it('accepts autoApprove: true round-tripped from the relational settings row the read path serves', async () => {
    // The read path assembles autoApprove from config_policy_patch_settings,
    // not the link JSONB; a stale tab re-sending it unchanged must still save.
    const tx = txWithStoredPatchLink(PATCH_INPUT_NO_APPROVAL);
    tx.select
      .mockImplementationOnce(() => selectLimitRows([
        { id: 'link-1', configPolicyId: 'policy-1', featureType: 'patch', featurePolicyId: null, inlineSettings: PATCH_INPUT_NO_APPROVAL },
      ]))
      .mockImplementationOnce(() => selectLimitRows([{ autoApprove: true }]));
    await expect(updateFeatureLink('link-1', {
      inlineSettings: { ...PATCH_INPUT_NO_APPROVAL, autoApprove: true, autoApproveSeverities: ['critical'] },
    }, 'policy-1')).resolves.not.toBeNull();
  });

  function ring(appRules: unknown[], valid = true, ringId: string | null = 'ring-1') {
    return { classification: valid ? (ringId ? 'patch_policy' : 'null') : 'missing_target', valid, ringId, ringName: null,
      categoryRules: [], categories: [], excludeCategories: [], autoApprove: {}, appRules };
  }
  const ENFORCED_RULES = [
    { source: 'third_party', packageId: 'mozilla.firefox', action: 'block' },
    { source: 'custom', packageId: '7ZIP.7zip', action: 'pin', pinnedVersion: '23.01' },
  ];

  it('addFeatureLink rejects app rules with no ring, or a ring that does not carry them, before opening a transaction', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    await expect(addFeatureLink('policy-1', 'patch', null, { ...PATCH_INPUT_NO_APPROVAL, apps: PATCH_INPUT.apps }))
      .rejects.toMatchObject(moved);
    resolvePatchPolicyReferenceMock.mockResolvedValueOnce(ring([ENFORCED_RULES[0]]));
    await expect(addFeatureLink('policy-1', 'patch', 'ring-1', { ...PATCH_INPUT_NO_APPROVAL, apps: PATCH_INPUT.apps }))
      .rejects.toMatchObject(moved);
    resolvePatchPolicyReferenceMock.mockResolvedValueOnce(ring(PATCH_INPUT.apps, false));
    await expect(addFeatureLink('policy-1', 'patch', 'ring-1', { ...PATCH_INPUT_NO_APPROVAL, apps: PATCH_INPUT.apps }))
      .rejects.toMatchObject(moved);
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('addFeatureLink accepts an Override copy: app rules the linked ring already enforces, and the inert autoApprove flag', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    resolvePatchPolicyReferenceMock.mockResolvedValue(ring(ENFORCED_RULES));
    // The transaction body is out of scope here; stop at it and assert the
    // guard let the write through to it.
    vi.mocked(db.transaction).mockImplementation(async () => { throw new Error('reached the write'); });
    const err = await addFeatureLink('policy-1', 'patch', 'ring-1', { ...PATCH_INPUT, apps: PATCH_INPUT.apps })
      .then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('reached the write');
    expect(resolvePatchPolicyReferenceMock).toHaveBeenCalledWith('partner-1', 'ring-1');
  });

  it('rejects a ring change that re-sends a non-empty apps list (a tab loaded before the cutover)', async () => {
    // The backfill moved this ring-less link onto 'ring-migrated'; the stale
    // tab still holds featurePolicyId null and the old rules.
    const tx = txWithStoredPatchLink(PATCH_INPUT, 'ring-migrated');
    await expect(updateFeatureLink('link-1', { featurePolicyId: null, inlineSettings: PATCH_INPUT }, 'policy-1'))
      .rejects.toMatchObject(moved);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('accepts a ring change without apps when the current ring is valid (the ring owns the rules)', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    resolvePatchPolicyReferenceMock.mockResolvedValue(ring(ENFORCED_RULES));
    const tx = txWithStoredPatchLink(PATCH_INPUT, 'ring-1');
    const { apps: _apps, ...rest } = PATCH_INPUT;
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2', inlineSettings: rest }, 'policy-1'))
      .resolves.not.toBeNull();
    expect(tx.update).toHaveBeenCalled();
  });

  it('repairing an invalid ring reference must not drop the link\'s legacy rules: the target ring has to carry them', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    resolvePatchPolicyReferenceMock
      .mockResolvedValueOnce(ring([], false, null))  // current: invalid reference
      .mockResolvedValueOnce(ring([]));              // target: a valid ring without the rules
    txWithStoredPatchLink(PATCH_INPUT, 'gone-ring');
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2' }, 'policy-1')).rejects.toMatchObject(ringLacksRules);

    resolvePatchPolicyReferenceMock
      .mockResolvedValueOnce(ring([], false, null))
      .mockResolvedValueOnce(ring(ENFORCED_RULES));
    txWithStoredPatchLink(PATCH_INPUT, 'gone-ring');
    await expect(updateFeatureLink('link-1', { featurePolicyId: 'ring-2' }, 'policy-1')).resolves.not.toBeNull();
  });

  it('repairing a link off a deleted ring (disabled_ring) needs the legacy rules on the target, with the repair code (#8678)', async () => {
    loadConfigPolicyPartnerIdMock.mockResolvedValue('partner-1');
    resolvePatchPolicyReferenceMock
      .mockResolvedValueOnce({ ...ring([], false, null), classification: 'disabled_ring' })
      .mockResolvedValueOnce(ring([]));
    const tx = txWithStoredPatchLink(PATCH_INPUT, 'deleted-ring');
    const err = await updateFeatureLink('link-1', { featurePolicyId: 'ring-2' }, 'policy-1')
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject(ringLacksRules);
    // Still the class the routes and the AI tool map to a 400.
    const { PolicyApprovalFieldMovedError } = await import('./configPolicyPatching');
    expect(err).toBeInstanceOf(PolicyApprovalFieldMovedError);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('does not apply to other feature types', async () => {
    const tx: any = {
      select: vi.fn(() => selectLimitRows([
        { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: {} },
      ])),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'link-pam' }])) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    await expect(updateFeatureLink('link-pam', { inlineSettings: { uacInterceptionEnabled: false } }, 'policy-1'))
      .resolves.not.toBeNull();
  });
});

describe('patch feature link round-trip (apps + autoApproveDeferralDays)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #8186: a NEW patch link can no longer carry approval rules (they live on
  // the Update Ring), so the add half of this round-trip saves none; the read
  // half still merges the JSON-only fields from the stored mirror.
  it('persists autoApproveDeferralDays in JSONB on save and returns the JSON-only fields from listFeatureLinks', async () => {
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
              onConflictDoNothing: vi.fn(() => ({
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
              })),
            };
          }
          // config_policy_patch_settings insert (decomposeInlineSettings)
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'patch', null, PATCH_INPUT_NO_APPROVAL);

    // The JSONB mirror must keep the JSON-only fields...
    expect(storedJsonb.apps).toEqual([]);
    expect(storedJsonb.autoApproveDeferralDays).toBe(7);
    // Simulate a link migrated before #8186 that still carries inline rules,
    // so the read half proves the merge.
    (link as any).inlineSettings = { ...(link as any).inlineSettings, apps: PATCH_INPUT.apps };
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
    expect(settings.autoApprove).toBe(false);
    expect(settings.autoApproveSeverities).toEqual([]);
    expect(settings.scheduleFrequency).toBe('daily');
    expect(settings.scheduleTime).toBe('03:30');
    expect(settings.rebootPolicy).toBe('never');
  });

  it('updateFeatureLink keeps apps and autoApproveDeferralDays in the JSONB write (unchanged round-trip)', async () => {
    let setValues: any;
    const tx = {
      select: vi.fn(() =>
        selectLimitRows([
          {
            id: 'link-1',
            configPolicyId: 'policy-1',
            featureType: 'patch',
            featurePolicyId: null,
            // #8186: a stale Patch tab re-sends what it loaded; that is accepted.
            inlineSettings: PATCH_INPUT,
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
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: { uacInterceptionEnabled: false } },
              ])
            ),
          })),
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
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: {} },
              ])
            ),
          })),
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
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                { id: 'link-pam', configPolicyId: 'policy-1', featureType: 'pam', featurePolicyId: null, inlineSettings: null },
              ])
            ),
          })),
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

// ============================================================
// vulnerability inlineSettings service-layer validation (BE-16 gating)
// ============================================================

describe('addFeatureLink — vulnerability inlineSettings service-layer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTxReturning(inlineSettings: unknown) {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                { id: 'link-vuln', configPolicyId: 'policy-1', featureType: 'vulnerability', featurePolicyId: null, inlineSettings },
              ])
            ),
          })),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  }

  it('throws ZodError before the transaction when enabled is the string "true"', async () => {
    await expect(
      addFeatureLink('policy-1', 'vulnerability', null, { enabled: 'true' })
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('throws ZodError for an unknown extra key', async () => {
    await expect(
      addFeatureLink('policy-1', 'vulnerability', null, { enabled: true, rogue: 'x' })
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('enters the transaction for valid { enabled: false } and {}', async () => {
    mockTxReturning({ enabled: false });
    await expect(addFeatureLink('policy-1', 'vulnerability', null, { enabled: false })).resolves.toBeDefined();
    mockTxReturning({});
    await expect(addFeatureLink('policy-1', 'vulnerability', null, {})).resolves.toBeDefined();
  });

  it('skips validation when inlineSettings is null/undefined', async () => {
    mockTxReturning(null);
    await expect(addFeatureLink('policy-1', 'vulnerability', null, null)).resolves.toBeDefined();
    await expect(addFeatureLink('policy-1', 'vulnerability', null, undefined)).resolves.toBeDefined();
  });
});

describe('updateFeatureLink — vulnerability inlineSettings service-layer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTxWithExistingVulnLink() {
    const tx: any = {
      select: vi.fn(() => selectLimitRows([
        { id: 'link-vuln', configPolicyId: 'policy-1', featureType: 'vulnerability', featurePolicyId: null, inlineSettings: {} },
      ])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'link-vuln', featureType: 'vulnerability' }])),
          })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

  it('throws ZodError when updating with a non-boolean enabled', async () => {
    makeTxWithExistingVulnLink();
    await expect(
      updateFeatureLink('link-vuln', { inlineSettings: { enabled: 'true' } }, 'policy-1')
    ).rejects.toThrow();
  });

  it('throws ZodError when updating with an unknown extra key', async () => {
    makeTxWithExistingVulnLink();
    await expect(
      updateFeatureLink('link-vuln', { inlineSettings: { enabled: true, rogue: true } }, 'policy-1')
    ).rejects.toThrow();
  });

  it('succeeds when updating with valid { enabled: true }', async () => {
    makeTxWithExistingVulnLink();
    const result = await updateFeatureLink('link-vuln', { inlineSettings: { enabled: true } }, 'policy-1');
    expect(result).not.toBeNull();
  });
});

describe('validateFeaturePolicyExists — vulnerability is inline-only', () => {
  it('rejects a featurePolicyId (vulnerability has no standalone policy table)', async () => {
    const result = await validateFeaturePolicyExists('vulnerability', 'some-uuid', { orgId: 'org-1', partnerId: null });
    expect(result.valid).toBe(false);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const result = await validateFeaturePolicyExists('vulnerability', null, { orgId: 'org-1', partnerId: null });
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// Partner-wide administration capability (single source of truth)
// ============================================================

describe('canManagePartnerWidePolicies', () => {
  it.each([
    // [scope, partnerOrgAccess, expected]
    ['system', undefined, true],
    ['system', 'none', true], // system short-circuits regardless of flag
    ['partner', 'all', true],
    ['partner', 'selected', false],
    ['partner', 'none', false],
    ['partner', undefined, false], // membership-less / MCP-key contexts fail closed
    ['organization', undefined, false],
    ['organization', 'all', false], // org scope never administers partner-wide state
  ] as const)('scope=%s partnerOrgAccess=%s → %s', (scope, partnerOrgAccess, expected) => {
    expect(canManagePartnerWidePolicies({ scope, partnerOrgAccess } as never)).toBe(expected);
  });
});

describe('updateConfigPolicy / deleteConfigPolicy — partner-wide administration gate', () => {
  // policyAccessCondition treats an undefined orgCondition as "no app-layer
  // filter" — irrelevant here since db is fully mocked; only the fetched row's
  // orgId and the auth capability drive the gate under test.
  const partnerAuth = (partnerOrgAccess?: 'all' | 'selected' | 'none'): never =>
    ({
      scope: 'partner',
      partnerId: 'partner-1',
      orgId: null,
      partnerOrgAccess,
      orgCondition: () => undefined,
      user: { id: 'user-1' },
    }) as never;

  const PARTNER_WIDE_ROW = { id: 'policy-1', orgId: null, partnerId: 'partner-1', name: 'Wide', status: 'active' };

  function mockSelectExisting(row: Record<string, unknown> | null) {
    vi.mocked(db.select).mockReturnValue(selectLimitRows(row ? [row] : []) as never);
  }

  function mockUpdateReturning(row: Record<string, unknown>) {
    const chain: any = {};
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([row]));
    vi.mocked(db.update).mockReturnValue(chain);
  }

  function mockDeleteReturning(row: Record<string, unknown>) {
    const chain: any = {};
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([row]));
    vi.mocked(db.delete).mockReturnValue(chain);
  }

  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
  });

  it('updateConfigPolicy throws PartnerWideWriteDeniedError for a partner-wide policy without orgAccess=all', async () => {
    mockSelectExisting(PARTNER_WIDE_ROW);
    await expect(
      updateConfigPolicy('policy-1', { name: 'Renamed' }, partnerAuth('selected'))
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('deleteConfigPolicy throws PartnerWideWriteDeniedError for a partner-wide policy without orgAccess=all', async () => {
    mockSelectExisting(PARTNER_WIDE_ROW);
    await expect(deleteConfigPolicy('policy-1', partnerAuth('none'))).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError
    );
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('updateConfigPolicy proceeds for a partner-wide policy with orgAccess=all', async () => {
    mockSelectExisting(PARTNER_WIDE_ROW);
    mockUpdateReturning({ ...PARTNER_WIDE_ROW, name: 'Renamed' });
    const updated = await updateConfigPolicy('policy-1', { name: 'Renamed' }, partnerAuth('all'));
    expect(updated?.name).toBe('Renamed');
  });

  it('deleteConfigPolicy proceeds for a partner-wide policy with orgAccess=all', async () => {
    mockSelectExisting(PARTNER_WIDE_ROW);
    mockDeleteReturning(PARTNER_WIDE_ROW);
    const deleted = await deleteConfigPolicy('policy-1', partnerAuth('all'));
    expect(deleted?.id).toBe('policy-1');
  });

  it('org-owned policies are NOT gated (a selected-access partner user may still edit them)', async () => {
    mockSelectExisting({ ...PARTNER_WIDE_ROW, orgId: 'org-1', partnerId: null });
    mockUpdateReturning({ ...PARTNER_WIDE_ROW, orgId: 'org-1', partnerId: null, name: 'Renamed' });
    const updated = await updateConfigPolicy('policy-1', { name: 'Renamed' }, partnerAuth('selected'));
    expect(updated?.name).toBe('Renamed');
  });
});

// ============================================================
// validateFeaturePolicyExists — software_policy dual-axis (#2126)
// ============================================================

describe('validateFeaturePolicyExists — patch ring must be enabled (#8678)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('rejects linking a deleted (enabled = false) ring', async () => {
    vi.mocked(db.select).mockReturnValue(selectLimitRows([{ id: 'ring-1', enabled: false }]) as never);
    const result = await validateFeaturePolicyExists('patch', 'ring-1', { orgId: null, partnerId: 'partner-1' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/deleted or disabled/i);
  });

  it('accepts an enabled ring', async () => {
    vi.mocked(db.select).mockReturnValue(selectLimitRows([{ id: 'ring-1', enabled: true }]) as never);
    const result = await validateFeaturePolicyExists('patch', 'ring-1', { orgId: null, partnerId: 'partner-1' });
    expect(result).toEqual({ valid: true });
  });

  it('still rejects a ring that does not exist for the partner', async () => {
    vi.mocked(db.select).mockReturnValue(selectLimitRows([]) as never);
    const result = await validateFeaturePolicyExists('patch', 'ring-1', { orgId: null, partnerId: 'partner-1' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not found for this partner/i);
  });
});

describe('validateFeaturePolicyExists — software_policy dual-axis linking (#2126)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  function mockLookupReturns(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue(selectLimitRows(rows) as never);
  }

  it('accepts inline-only (no featurePolicyId)', async () => {
    const result = await validateFeaturePolicyExists('software_policy', null, { orgId: 'org-1', partnerId: null });
    expect(result.valid).toBe(true);
  });

  it('a PARTNER-WIDE config policy can link a partner-owned software template', async () => {
    mockLookupReturns([{ id: 'sw-1' }]);
    const result = await validateFeaturePolicyExists('software_policy', 'sw-1', { orgId: null, partnerId: 'partner-1' });
    expect(result.valid).toBe(true);
  });

  it('an ORG-owned config policy can link a software policy (own org or its partner template)', async () => {
    mockLookupReturns([{ id: 'sw-1' }]);
    const result = await validateFeaturePolicyExists('software_policy', 'sw-1', { orgId: 'org-1', partnerId: null });
    expect(result.valid).toBe(true);
  });

  it('rejects a software policy id that resolves to neither axis', async () => {
    mockLookupReturns([]);
    const result = await validateFeaturePolicyExists('software_policy', 'missing', { orgId: null, partnerId: 'partner-1' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('a PARTNER-WIDE config policy can link a partner-owned SECURITY policy (#2127)', async () => {
    mockLookupReturns([{ id: 'sec-1' }]);
    const result = await validateFeaturePolicyExists('security', 'sec-1', { orgId: null, partnerId: 'partner-1' });
    expect(result.valid).toBe(true);
  });

  it('never resolves a software policy GENERATED from a security_agents link (#6960 carry-forward)', async () => {
    const chain = selectLimitRows([{ id: 'sw-1' }]);
    vi.mocked(db.select).mockReturnValue(chain as never);
    await validateFeaturePolicyExists('software_policy', 'sw-1', { orgId: 'org-1', partnerId: null });
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const rendered = new PgDialect().sqlToQuery(chain.where.mock.calls.at(-1)[0]).sql;
    expect(rendered).toMatch(/"managed_by_link_id" is null/i);
  });

  it('does not add the managed predicate to other dual-axis types', async () => {
    const chain = selectLimitRows([{ id: 'sec-1' }]);
    vi.mocked(db.select).mockReturnValue(chain as never);
    await validateFeaturePolicyExists('security', 'sec-1', { orgId: 'org-1', partnerId: null });
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const rendered = new PgDialect().sqlToQuery(chain.where.mock.calls.at(-1)[0]).sql;
    expect(rendered).not.toMatch(/managed_by_link_id/i);
  });

  it('rejects a security policy id that resolves to neither axis', async () => {
    mockLookupReturns([]);
    const result = await validateFeaturePolicyExists('security', 'missing', { orgId: 'org-1', partnerId: null });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Security policy .* not found/i);
  });
});

// ============================================================
// onConflictDoNothing duplicate handling (issue #2189) — a raised unique
// violation gets re-thrown by postgres.js at withDbAccessContext commit time
// even after a caller catches it, turning a mapped 409 back into a raw 500
// (see createCatalogItem in catalogService.ts). Both inserts below suppress
// the conflict at the statement level and return null instead.
// ============================================================

describe('addFeatureLink — duplicate feature link returns null instead of throwing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when onConflictDoNothing suppresses a duplicate (config_feature_links_unique)', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([])),
          })),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'patch', null, null);
    expect(link).toBeNull();
  });
});

describe('assignPolicy — duplicate assignment returns null instead of throwing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when onConflictDoNothing suppresses a duplicate (config_assignments_unique)', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    } as any);

    const assignment = await assignPolicy('policy-1', 'device', 'device-1', 0, 'user-1');
    expect(assignment).toBeNull();
  });
});

describe('remote_access feature link — legacy capability JSONB (#2320)', () => {
  const CAPABILITY_SETTINGS = {
    webrtcDesktop: true,
    vncRelay: false,
    remoteTools: true,
    clipboardHostToViewer: true,
    clipboardViewerToHost: true,
    enableProxy: false,
    defaultAllowedPorts: [80, 443, 8080, 8443],
    autoEnableProxy: false,
    maxConcurrentTunnels: 5,
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listFeatureLinks returns a stored legacy capability-shape row untouched (no normalized row)', async () => {
    // A policy saved pre-#1694 has ONLY capability keys in the JSONB and no
    // config_policy_remote_access_settings row — reads must fall back to the
    // JSONB so the Remote Access tab shows the real values, not "Not configured".
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-ra',
            configPolicyId: 'policy-1',
            featureType: 'remote_access',
            featurePolicyId: null,
            inlineSettings: { ...CAPABILITY_SETTINGS },
          },
        ]) as any
      )
      .mockReturnValueOnce(selectLimitRows([]) as any); // no normalized consent row

    const result = await listFeatureLinks('policy-1');
    expect(result).toHaveLength(1);
    expect(result[0]!.inlineSettings).toEqual(CAPABILITY_SETTINGS);
  });

  it('listFeatureLinks merges capability JSONB with the normalized consent row (consent row wins)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectWhereRows([
          {
            id: 'link-ra',
            configPolicyId: 'policy-1',
            featureType: 'remote_access',
            featurePolicyId: null,
            // Stale consent value in the mirror — the normalized row must win.
            inlineSettings: { ...CAPABILITY_SETTINGS, sessionPromptMode: 'off' },
          },
        ]) as any
      )
      .mockReturnValueOnce(
        selectLimitRows([
          {
            id: 'ras-1',
            featureLinkId: 'link-ra',
            sessionPromptMode: 'consent',
            consentUnavailableBehavior: 'block',
            notifyOnSessionEnd: true,
            showActiveIndicator: true,
            technicianIdentityLevel: 'name',
          },
        ]) as any
      );

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as Record<string, unknown>;

    // Capability fields survive from the JSONB mirror...
    expect(settings.webrtcDesktop).toBe(true);
    expect(settings.defaultAllowedPorts).toEqual([80, 443, 8080, 8443]);
    expect(settings.maxConcurrentTunnels).toBe(5);
    // ...and the normalized consent row overrides the stale mirror value.
    expect(settings.sessionPromptMode).toBe('consent');
    expect(settings.consentUnavailableBehavior).toBe('block');
    expect(settings.technicianIdentityLevel).toBe('name');
  });

  it('addFeatureLink stores the full blob in JSONB and only consent fields in the normalized row', async () => {
    let storedJsonb: any;
    let normalizedRowValues: any;
    let insertCall = 0;

    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            storedJsonb = v.inlineSettings;
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    {
                      id: 'link-ra',
                      configPolicyId: 'policy-1',
                      featureType: 'remote_access',
                      featurePolicyId: null,
                      inlineSettings: v.inlineSettings,
                    },
                  ])
                ),
              })),
            };
          }
          // config_policy_remote_access_settings insert (decomposeInlineSettings)
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const input = { ...CAPABILITY_SETTINGS, sessionPromptMode: 'consent' };
    const link = await addFeatureLink('policy-1', 'remote_access', null, input);
    expect(link).not.toBeNull();

    // JSONB mirror keeps the capability fields (agent path reads these)...
    expect(storedJsonb.webrtcDesktop).toBe(true);
    expect(storedJsonb.defaultAllowedPorts).toEqual([80, 443, 8080, 8443]);
    // ...the normalized row gets only the consent columns — the old .strict()
    // parse THREW here on capability keys, killing the whole save (#2320).
    expect(normalizedRowValues.featureLinkId).toBe('link-ra');
    expect(normalizedRowValues.sessionPromptMode).toBe('consent');
    expect(normalizedRowValues.webrtcDesktop).toBeUndefined();
  });

  it('addFeatureLink rejects invalid capability values at the service layer (AI tool path)', async () => {
    await expect(
      addFeatureLink('policy-1', 'remote_access', null, { webrtcDesktop: 'yes' })
    ).rejects.toThrow();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('updateFeatureLink rejects invalid capability values at the service layer (AI tool path)', async () => {
    const tx = {
      select: vi.fn(() =>
        selectLimitRows([
          {
            id: 'link-ra',
            configPolicyId: 'policy-1',
            featureType: 'remote_access',
            featurePolicyId: null,
            inlineSettings: {},
          },
        ])
      ),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await expect(
      updateFeatureLink('link-ra', { inlineSettings: { idleTimeoutMinutes: 99999 } }, 'policy-1')
    ).rejects.toThrow();
  });
});

describe('remote_access updateFeatureLink — merge semantics (partial updates cannot reset the other surface)', () => {
  const STORED_MIXED = {
    webrtcDesktop: true,
    vncRelay: true,
    remoteTools: true,
    clipboardHostToViewer: false,
    clipboardViewerToHost: true,
    enableProxy: false,
    defaultAllowedPorts: [443],
    autoEnableProxy: false,
    maxConcurrentTunnels: 5,
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
    sessionPromptMode: 'consent',
    consentUnavailableBehavior: 'block',
    notifyOnSessionEnd: true,
    showActiveIndicator: true,
    technicianIdentityLevel: 'generic',
  };

  function buildUpdateTx(existingInlineSettings: unknown) {
    const captured: { setValues?: any; normalizedRowValues?: any } = {};
    const tx = {
      select: vi.fn(() =>
        selectLimitRows([
          {
            id: 'link-ra',
            configPolicyId: 'policy-1',
            featureType: 'remote_access',
            featurePolicyId: null,
            inlineSettings: existingInlineSettings,
          },
        ])
      ),
      update: vi.fn(() => ({
        set: vi.fn((v: any) => {
          captured.setValues = v;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ id: 'link-ra' }])),
            })),
          };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          captured.normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    return { tx, captured };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a capability-only update preserves the stored consent settings (AI tool path)', async () => {
    const { tx, captured } = buildUpdateTx({ ...STORED_MIXED });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const updated = await updateFeatureLink(
      'link-ra',
      { inlineSettings: { webrtcDesktop: false } },
      'policy-1'
    );
    expect(updated).not.toBeNull();

    // The changed field is applied...
    expect(captured.setValues.inlineSettings.webrtcDesktop).toBe(false);
    // ...the untouched capability fields survive in the mirror...
    expect(captured.setValues.inlineSettings.clipboardHostToViewer).toBe(false);
    expect(captured.setValues.inlineSettings.defaultAllowedPorts).toEqual([443]);
    // ...and the consent fields do NOT reset to schema defaults — the
    // re-created normalized row keeps them (would be 'notify'/'name_email'
    // under replace semantics).
    expect(captured.setValues.inlineSettings.sessionPromptMode).toBe('consent');
    expect(captured.normalizedRowValues.sessionPromptMode).toBe('consent');
    expect(captured.normalizedRowValues.consentUnavailableBehavior).toBe('block');
    expect(captured.normalizedRowValues.technicianIdentityLevel).toBe('generic');
  });

  it('a consent-only update preserves the stored capability settings (no fail-open re-enable)', async () => {
    const { tx, captured } = buildUpdateTx({ ...STORED_MIXED, webrtcDesktop: false, enableProxy: false });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const updated = await updateFeatureLink(
      'link-ra',
      { inlineSettings: { sessionPromptMode: 'notify' } },
      'policy-1'
    );
    expect(updated).not.toBeNull();

    // Deliberately disabled capabilities must stay disabled in the mirror —
    // dropping them would let the permissive baseline re-enable them.
    expect(captured.setValues.inlineSettings.webrtcDesktop).toBe(false);
    expect(captured.setValues.inlineSettings.enableProxy).toBe(false);
    expect(captured.setValues.inlineSettings.sessionPromptMode).toBe('notify');
    expect(captured.normalizedRowValues.sessionPromptMode).toBe('notify');
    // Consent fields not present in the update keep their stored values.
    expect(captured.normalizedRowValues.technicianIdentityLevel).toBe('generic');
  });

  it('unknown keys are stripped from the stored mirror instead of persisted as no-ops', async () => {
    const { tx, captured } = buildUpdateTx({ ...STORED_MIXED });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await updateFeatureLink(
      'link-ra',
      // An AI-guessed key: must not be stored and echoed back as if it worked.
      { inlineSettings: { remoteDesktop: false } as Record<string, unknown> },
      'policy-1'
    );

    expect(captured.setValues.inlineSettings).not.toHaveProperty('remoteDesktop');
    // And nothing else changed.
    expect(captured.setValues.inlineSettings.webrtcDesktop).toBe(true);
    expect(captured.setValues.inlineSettings.sessionPromptMode).toBe('consent');
  });

  it('a malformed legacy stored blob does not block the update (safeParse fallback)', async () => {
    const { tx, captured } = buildUpdateTx({ webrtcDesktop: 'garbage' });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const updated = await updateFeatureLink(
      'link-ra',
      { inlineSettings: { webrtcDesktop: false } },
      'policy-1'
    );
    expect(updated).not.toBeNull();
    expect(captured.setValues.inlineSettings).toEqual({ webrtcDesktop: false });
  });
});

describe('remote_access addFeatureLink — unknown keys stripped from the stored mirror', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist an AI-guessed key alongside the valid fields', async () => {
    let storedJsonb: any;
    let insertCall = 0;
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            storedJsonb = v.inlineSettings;
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    {
                      id: 'link-ra',
                      configPolicyId: 'policy-1',
                      featureType: 'remote_access',
                      featurePolicyId: null,
                      inlineSettings: v.inlineSettings,
                    },
                  ])
                ),
              })),
            };
          }
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await addFeatureLink('policy-1', 'remote_access', null, {
      webrtcDesktop: false,
      allowRemoteControl: false, // unknown — must be stripped, not stored
    });

    expect(storedJsonb).toEqual({ webrtcDesktop: false });
  });
});

// ============================================================================
// listConfigPolicies — Features column data (#2950)
// ============================================================================

describe('listConfigPolicies feature links', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';

  function orgAuth(): any {
    return {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      // Any truthy SQL stands in for the real org filter; the mocked db never
      // interprets it.
      orgCondition: () => ({ queryChunks: [] }),
    };
  }

  // db.select({count}).from().where() — awaited straight off .where()
  function countChain(total: number) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ count: total }]));
    return chain;
  }

  // db.select().from().leftJoin().where().orderBy().limit().offset()
  function pageChain(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  // db.select().from().where().orderBy() — awaited off .orderBy()
  function linksChain(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  // db.select({partnerId}).from(organizations).where().limit(1) — the extra
  // statement the orgId-filter branch issues BEFORE the count query.
  function orgPartnerChain(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches each policy its own feature links, and an empty array when it has none', async () => {
    const rows = [
      { id: 'policy-a', name: 'Workstations', orgId: ORG_ID, orgName: 'OliveTech' },
      { id: 'policy-b', name: 'Servers', orgId: ORG_ID, orgName: 'OliveTech' },
    ];
    const links = linksChain([
      { id: 'link-1', configPolicyId: 'policy-a', featureType: 'patch' },
      { id: 'link-2', configPolicyId: 'policy-a', featureType: 'patch' },
    ]);

    vi.mocked(db.select)
      .mockReturnValueOnce(countChain(2) as any)
      .mockReturnValueOnce(pageChain(rows) as any)
      .mockReturnValueOnce(links as any);

    const result = await listConfigPolicies(orgAuth(), {}, { page: 1, limit: 25 });

    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: 'policy-a',
      featureLinks: [
        { id: 'link-1', featureType: 'patch' },
        { id: 'link-2', featureType: 'patch' },
      ],
    });
    // No links of its own — must be [], never another policy's links and never
    // undefined (the UI renders the em-dash only for a genuinely empty array).
    expect(result.data[1]).toMatchObject({ id: 'policy-b', featureLinks: [] });
    // Pre-existing fields are untouched: the change is purely additive.
    expect(result.data[0]).toMatchObject({ name: 'Workstations', orgName: 'OliveTech' });
    expect(result.pagination).toEqual({ page: 1, limit: 25, total: 2 });
  });

  it('batches the feature-link read into ONE statement for the whole page (no N+1)', async () => {
    const rows = [
      { id: 'policy-a', name: 'A', orgId: ORG_ID },
      { id: 'policy-b', name: 'B', orgId: ORG_ID },
      { id: 'policy-c', name: 'C', orgId: ORG_ID },
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(countChain(3) as any)
      .mockReturnValueOnce(pageChain(rows) as any)
      .mockReturnValueOnce(linksChain([]) as any);

    await listConfigPolicies(orgAuth(), {}, { page: 1, limit: 25 });

    // count + page + links === 3 total, regardless of how many policies the
    // page holds. A per-policy read would make this grow with `rows.length`.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
  });

  it('keys the batched read on config_policy_id and lets the DB do the ordering', async () => {
    const rows = [{ id: 'policy-a', name: 'A', orgId: ORG_ID }];
    const links = linksChain([
      { id: 'link-2', configPolicyId: 'policy-a', featureType: 'patch' },
      { id: 'link-1', configPolicyId: 'policy-a', featureType: 'patch' },
    ]);

    vi.mocked(db.select)
      .mockReturnValueOnce(countChain(1) as any)
      .mockReturnValueOnce(pageChain(rows) as any)
      .mockReturnValueOnce(links as any);

    const result = await listConfigPolicies(orgAuth(), {}, { page: 1, limit: 25 });

    // The WHERE targets configPolicyId (not id) — swapping the column would
    // return the wrong links and is otherwise invisible through the mock.
    // Compare against the Column object itself: the SQL wrapper is circular,
    // so it cannot be serialized.
    const whereArg: any = links.where.mock.calls[0][0];
    const where = new PgDialect().sqlToQuery(whereArg).sql;
    expect(where).toContain('"config_policy_feature_links"."config_policy_id" in');
    expect(where).not.toContain('"config_policy_feature_links"."id" in');
    // Retired alert_rule/monitoring links never reach a policy listing.
    expect(where).toContain('"config_policy_feature_links"."feature_type" not in');
    // Ordering is delegated to the query, so the service must NOT re-sort:
    // rows come back in whatever order the DB produced them.
    expect(links.orderBy).toHaveBeenCalledTimes(1);
    const first = result.data[0];
    expect(first).toBeDefined();
    expect(first?.featureLinks.map((l) => l.id)).toEqual(['link-2', 'link-1']);
  });

  it('attaches links on the orgId-filtered path (the one the UI actually uses)', async () => {
    // ConfigurationPoliciesPage sends orgId whenever an org is selected, which
    // adds a partnerId lookup BEFORE the count query — so the statement
    // sequence differs from the no-filter path exercised above. This also
    // covers a partner-wide row (orgId null) carrying its own links.
    const rows = [
      { id: 'policy-partnerwide', name: 'All orgs', orgId: null, orgName: null },
      { id: 'policy-org', name: 'OliveTech only', orgId: ORG_ID, orgName: 'OliveTech' },
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce(orgPartnerChain([{ partnerId: 'partner-1' }]) as any)
      .mockReturnValueOnce(countChain(2) as any)
      .mockReturnValueOnce(pageChain(rows) as any)
      .mockReturnValueOnce(
        linksChain([
          { id: 'link-pw', configPolicyId: 'policy-partnerwide', featureType: 'patch' },
          { id: 'link-org', configPolicyId: 'policy-org', featureType: 'security' },
        ]) as any,
      );

    const result = await listConfigPolicies(
      orgAuth(),
      { orgId: ORG_ID },
      { page: 1, limit: 25 },
    );

    expect(result.data[0]).toMatchObject({
      id: 'policy-partnerwide',
      featureLinks: [{ id: 'link-pw', featureType: 'patch' }],
    });
    expect(result.data[1]).toMatchObject({
      id: 'policy-org',
      featureLinks: [{ id: 'link-org', featureType: 'security' }],
    });
    // partnerId lookup + count + page + links — still ONE links statement.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });

  it('skips the feature-link query entirely when the page is empty', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(countChain(0) as any)
      .mockReturnValueOnce(pageChain([]) as any);

    const result = await listConfigPolicies(orgAuth(), {}, { page: 5, limit: 25 });

    expect(result.data).toEqual([]);
    // An inArray() against an empty id list is a SQL error in Drizzle, so the
    // third statement must not be issued at all.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// #6312 — maintenance inlineSettings service-layer validation
// ============================================================

describe('addFeatureLink — maintenance inlineSettings service-layer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Only satisfies the first (feature link) insert — decompose's schema.parse()
  // throws before the config_policy_maintenance_settings insert is attempted.
  function txForFeatureLinkInsertOnly() {
    return {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                {
                  id: 'link-maint',
                  configPolicyId: 'policy-1',
                  featureType: 'maintenance',
                  featurePolicyId: null,
                  inlineSettings: v.inlineSettings,
                },
              ])
            ),
          })),
        })),
      })),
    };
  }

  // The route is a pre-check, not the enforcement boundary: the AI
  // manage_policy_feature_link tool and any other direct caller reach
  // addFeatureLink without passing through it.
  it.each([
    ['an unknown recurrence', { recurrence: 'fortnightly' }],
    ['a negative durationHours', { durationHours: -5 }],
    ['a non-IANA timezone', { timezone: 'Nowhere/Nope' }],
    ['an unparseable recurring windowStart', { recurrence: 'daily', windowStart: 'banana' }],
    ["a 'once' window with no start", { recurrence: 'once', windowStart: '' }],
  ])('refuses maintenance inlineSettings with %s', async (_label, inlineSettings) => {
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(txForFeatureLinkInsertOnly()));

    await expect(
      addFeatureLink('policy-1', 'maintenance', null, inlineSettings)
    ).rejects.toThrow();
  });

  it('writes the parsed settings — not the old typeof-coerced defaults — to the normalized row', async () => {
    let normalizedRowValues: any;
    let insertCall = 0;
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    {
                      id: 'link-maint',
                      configPolicyId: 'policy-1',
                      featureType: 'maintenance',
                      featurePolicyId: null,
                      inlineSettings: v.inlineSettings,
                    },
                  ])
                ),
              })),
            };
          }
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'maintenance', null, {
      recurrence: 'daily',
      windowStart: '02:30',
      durationHours: 4,
      timezone: 'America/New_York',
    });

    expect(link).not.toBeNull();
    expect(normalizedRowValues).toMatchObject({
      featureLinkId: 'link-maint',
      recurrence: 'daily',
      windowStart: '02:30',
      durationHours: 4,
      timezone: 'America/New_York',
      // Schema defaults, identical to what the old coercion produced for the
      // fields the caller omitted.
      suppressAlerts: true,
      suppressPatching: false,
      suppressAutomations: false,
      suppressScripts: false,
      rebootIfPending: false,
      notifyBeforeMinutes: 15,
      notifyOnStart: true,
      notifyOnEnd: true,
    });
  });

  it('normalizes an empty recurring windowStart to null (the midnight anchor)', async () => {
    let normalizedRowValues: any;
    let insertCall = 0;
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    { id: 'link-maint', configPolicyId: 'policy-1', featureType: 'maintenance', featurePolicyId: null, inlineSettings: v.inlineSettings },
                  ])
                ),
              })),
            };
          }
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await addFeatureLink('policy-1', 'maintenance', null, { recurrence: 'weekly', windowStart: '' });

    expect(normalizedRowValues.windowStart).toBeNull();
  });
});
