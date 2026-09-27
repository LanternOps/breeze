import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors the mocking preamble in configurationPolicy.test.ts. Kept in a
// separate file (Task 7, #5289) so the 'monitors' feature type gets its own
// focused suite rather than growing the already-large shared file further.
vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: vi.fn(),
}));

vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((actions: unknown) => actions),
  resolveAutomationReferencesForOwner: vi.fn(),
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
}));

import {
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  validateFeaturePolicyExists,
} from './configurationPolicy';
import { db } from '../db';
import { configPolicyAlertRules, configPolicyMonitors, configPolicyMonitoringSettings, configPolicyFeatureLinks } from '../db/schema';

beforeEach(() => { vi.mocked(db.select).mockReset(); });

const MONITOR_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MONITOR_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Chain for `db.select().from(...).where(...)` awaited directly (links query)
function selectWhereRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

// Chain for `db.select().from(...).where(...).orderBy(...)` (normalized rows query)
function selectOrderByRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function selectLimitRows(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("addFeatureLink — 'monitors' inlineSettings decompose", () => {
  it('inserts one config_policy_monitors row per item, mirroring alert_rule', async () => {
    let normalizedRowValues: any;
    let insertCall = 0;
    const tx = {
      select: vi.fn(() => selectLimitRows([])),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    {
                      id: 'link-mon',
                      configPolicyId: 'policy-1',
                      featureType: 'monitors',
                      featurePolicyId: null,
                      inlineSettings: v.inlineSettings,
                    },
                  ])
                ),
              })),
            };
          }
          // config_policy_monitors insert (decomposeInlineSettings)
          if (table === configPolicyMonitoringSettings) return { onConflictDoUpdate: vi.fn(async () => []) };
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const link = await addFeatureLink('policy-1', 'monitors', null, {
      items: [{ monitorId: MONITOR_ID_1, enabled: false, overrides: { value: 95 } }],
    });

    expect(link).not.toBeNull();
    expect(tx.insert).not.toHaveBeenCalledWith(configPolicyMonitoringSettings);
    expect(link!.inlineSettings).not.toHaveProperty('checkIntervalSeconds');
    expect(normalizedRowValues).toHaveLength(1);
    expect(normalizedRowValues[0]).toMatchObject({
      featureLinkId: 'link-mon',
      monitorId: MONITOR_ID_1,
      enabled: false,
      overrides: { value: 95 },
      sortOrder: 0,
    });
  });

  it('defaults sortOrder to the array index and overrides to null when omitted', async () => {
    let normalizedRowValues: any;
    let insertCall = 0;
    const tx = {
      select: vi.fn(() => selectLimitRows([])),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((v: any) => {
          insertCall += 1;
          if (insertCall === 1) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(() =>
                  Promise.resolve([
                    { id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors', featurePolicyId: null, inlineSettings: v.inlineSettings },
                  ])
                ),
              })),
            };
          }
          if (table === configPolicyMonitoringSettings) return { onConflictDoUpdate: vi.fn(async () => []) };
          normalizedRowValues = v;
          return Promise.resolve([]);
        }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await addFeatureLink('policy-1', 'monitors', null, {
      items: [
        { monitorId: MONITOR_ID_1 },
        { monitorId: MONITOR_ID_2 },
      ],
    });

    expect(normalizedRowValues).toHaveLength(2);
    expect(normalizedRowValues[0]).toMatchObject({ monitorId: MONITOR_ID_1, enabled: true, overrides: null, sortOrder: 0 });
    expect(normalizedRowValues[1]).toMatchObject({ monitorId: MONITOR_ID_2, enabled: true, overrides: null, sortOrder: 1 });
  });

  it('returns an explicitly saved interval from its normalized row', async () => {
    let intervalRows: Array<{ checkIntervalSeconds: number }> = [];
    const tx = {
      select: vi.fn(() => selectLimitRows(intervalRows)),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: any) => table === configPolicyMonitoringSettings
          ? { onConflictDoUpdate: vi.fn(async () => {
            intervalRows = [{ checkIntervalSeconds: values.checkIntervalSeconds }];
          }) }
          : { onConflictDoNothing: () => ({ returning: async () => [{
            id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
            featurePolicyId: null, inlineSettings: values.inlineSettings,
          }] }) }),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    const link = await addFeatureLink('policy-1', 'monitors', null, {
      items: [], checkIntervalSeconds: 30,
    });
    expect(intervalRows).toEqual([{ checkIntervalSeconds: 30 }]);
    expect(tx.select).toHaveBeenCalled();
    expect(link!.inlineSettings).toMatchObject({ checkIntervalSeconds: 30 });
  });

  it('rejects a non-uuid monitorId before any insert', async () => {
    const tx = {
      select: vi.fn(() => selectLimitRows([])),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors', featurePolicyId: null, inlineSettings: {} }])),
          })),
        })),
      })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await expect(
      addFeatureLink('policy-1', 'monitors', null, { items: [{ monitorId: 'not-a-uuid' }] })
    ).rejects.toThrow();
  });
});

describe("updateFeatureLink — 'monitors' normalized row replacement", () => {
  function updateTx(existing: Record<string, unknown>, interval?: number) {
    const calls: Array<{ op: 'delete' | 'insert'; table: unknown; values?: any }> = [];
    let saved = { ...existing };
    let settings = interval === undefined ? [] : [{ checkIntervalSeconds: interval }];
    const tx: any = {
      select: vi.fn(() => ({ from: vi.fn((table: unknown) =>
        selectLimitRows(table === configPolicyMonitoringSettings ? settings : [saved])),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          saved = { ...saved, ...values };
          return { where: vi.fn(() => ({
            returning: vi.fn(async () => [{ ...saved }]),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
          })) };
        }),
      })),
      delete: vi.fn((table: unknown) => {
        calls.push({ op: 'delete', table });
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: any) => {
          calls.push({ op: 'insert', table, values });
          return table === configPolicyMonitoringSettings
            ? { onConflictDoUpdate: vi.fn(async () => { settings = [{ checkIntervalSeconds: values.checkIntervalSeconds }]; }) }
            : Promise.resolve([]);
        }),
      })),
    };
    return { tx, calls, getSaved: () => saved };
  }

  it.each([30, undefined])('attachment edits preserve explicit interval %s without inventing one', async (interval) => {
    const { tx, calls, getSaved } = updateTx({
      id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
      // The row wins even if the legacy JSON mirror is stale.
      featurePolicyId: null, inlineSettings: { items: [], ...(interval === undefined ? {} : { checkIntervalSeconds: 120 }) },
    }, interval);
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    const saved = await updateFeatureLink('link-mon', {
      inlineSettings: { items: [{ monitorId: MONITOR_ID_1 }], inheritance: 'cumulative' },
    }, 'policy-1');
    expect(calls.filter(c => c.table === configPolicyMonitoringSettings)).toEqual([]);
    if (interval === undefined) {
      expect(saved!.inlineSettings).not.toHaveProperty('checkIntervalSeconds');
      expect(getSaved().inlineSettings).not.toHaveProperty('checkIntervalSeconds');
    } else {
      expect(saved!.inlineSettings).toMatchObject({ checkIntervalSeconds: interval });
      expect(getSaved().inlineSettings).toMatchObject({ checkIntervalSeconds: interval });
    }
  });

  it('deletes the old config_policy_monitors rows, then reinserts them', async () => {
    const { tx, calls } = updateTx({
      id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: { items: [] },
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await updateFeatureLink('link-mon', {
      inlineSettings: { items: [{ monitorId: MONITOR_ID_1, enabled: true, sortOrder: 3 }] },
    }, 'policy-1');

    expect(calls.map((c) => c.op)).toEqual(['delete', 'insert']);
    expect(calls[0]!.table).toBe(configPolicyMonitors);
    expect(calls[1]!.table).toBe(configPolicyMonitors);

    const [row] = calls[1]!.values;
    expect(row).toMatchObject({
      featureLinkId: 'link-mon',
      monitorId: MONITOR_ID_1,
      enabled: true,
      sortOrder: 3,
    });
  });

  it('upserts interval and never deletes settings during last detachment', async () => {
    const { tx, calls } = updateTx({
      id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: { items: [{ monitorId: MONITOR_ID_1 }] },
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    const saved = await updateFeatureLink('link-mon', {
      inlineSettings: { items: [], inheritance: 'replace', checkIntervalSeconds: 60 },
    }, 'policy-1');
    expect(saved!.inlineSettings).toMatchObject({ checkIntervalSeconds: 60 });
    expect(calls.filter(c => c.op === 'delete').map(c => c.table)).toEqual([configPolicyMonitors]);
    expect(calls).toContainEqual({ op: 'insert', table: configPolicyMonitoringSettings,
      values: { featureLinkId: 'link-mon', checkIntervalSeconds: 60 } });
  });

  it('does not touch config_policy_alert_rules when a monitors link is updated', async () => {
    const { tx, calls } = updateTx({
      id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: { items: [] },
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await updateFeatureLink('link-mon', {
      inlineSettings: { items: [{ monitorId: MONITOR_ID_1 }] },
    }, 'policy-1');

    const deletedTables = calls.filter((c) => c.op === 'delete').map((c) => c.table);
    expect(deletedTables).toContain(configPolicyMonitors);
    expect(deletedTables).not.toContain(configPolicyAlertRules);
  });
});

describe("assembleInlineSettings via listFeatureLinks — 'monitors'", () => {
  it('returns items ordered by sortOrder', async () => {
    const link = {
      id: 'link-mon',
      configPolicyId: 'policy-1',
      featureType: 'monitors',
      featurePolicyId: null,
      inlineSettings: { items: [] },
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any) // links query
      .mockReturnValueOnce(
        selectOrderByRows([
          { id: 'row-2', featureLinkId: 'link-mon', monitorId: MONITOR_ID_2, enabled: true, overrides: null, sortOrder: 0 },
          { id: 'row-1', featureLinkId: 'link-mon', monitorId: MONITOR_ID_1, enabled: false, overrides: { value: 95 }, sortOrder: 1 },
        ]) as any
      ) // config_policy_monitors — already returned in sortOrder order by the mocked orderBy
      .mockReturnValueOnce(selectLimitRows([link]) as any)
      .mockReturnValueOnce(selectLimitRows([]) as any);

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as { items: Array<Record<string, unknown>> };

    expect(settings.items).toEqual([
      { monitorId: MONITOR_ID_2, enabled: true, overrides: null, sortOrder: 0 },
      { monitorId: MONITOR_ID_1, enabled: false, overrides: { value: 95 }, sortOrder: 1 },
    ]);
  });

  it('returns an empty items array (never the stale mirror) when no normalized rows exist', async () => {
    const link = {
      id: 'link-mon',
      configPolicyId: 'policy-1',
      featureType: 'monitors',
      featurePolicyId: null,
      inlineSettings: { items: [] },
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any)
      .mockReturnValueOnce(selectOrderByRows([]) as any)
      .mockReturnValueOnce(selectLimitRows([link]) as any)
      .mockReturnValueOnce(selectLimitRows([]) as any);

    const result = await listFeatureLinks('policy-1');
    // No normalized rows → assembleInlineSettings assembles straight from
    // config_policy_monitors (empty) rather than falling back to the link's
    // JSONB mirror.
    expect(result[0]!.inlineSettings).toEqual({ items: [], inheritance: 'cumulative' });
  });

  it('assembles the interval and replace mode with no attachments', async () => {
    const link = { id: 'link-mon', configPolicyId: 'policy-1', featureType: 'monitors',
      featurePolicyId: null, inlineSettings: { items: [], inheritance: 'replace' } };
    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any)
      .mockReturnValueOnce(selectOrderByRows([]) as any)
      .mockReturnValueOnce(selectLimitRows([link]) as any)
      .mockReturnValueOnce(selectLimitRows([{ checkIntervalSeconds: 45 }]) as any);
    const [saved] = await listFeatureLinks('policy-1');
    expect(saved!.inlineSettings).toEqual({ items: [], inheritance: 'replace', checkIntervalSeconds: 45 });
  });

  // Regression for #6493: deleting a monitor definition cascades (ON DELETE
  // CASCADE on config_policy_monitors.monitor_id) and empties the normalized
  // row out from under the feature link WITHOUT ever touching the link's
  // JSONB mirror, which still names the now-deleted monitor. Before the fix,
  // assembleInlineSettings returned null whenever no normalized rows existed
  // (the "cumulative" default), and listFeatureLinks then fell back to that
  // stale mirror — so the policy's Monitors tab kept rendering a row for a
  // monitor that no longer existed (a bare UUID, since the live monitor
  // catalog no longer has a name for it).
  it('does not resurrect a stale monitorId from the JSONB mirror once its config_policy_monitors row is gone (#6493)', async () => {
    const deletedMonitorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const link = {
      id: 'link-mon',
      configPolicyId: 'policy-1',
      featureType: 'monitors',
      featurePolicyId: null,
      // Stale write-time mirror: still names the monitor that was later
      // deleted and cascade-removed from config_policy_monitors.
      inlineSettings: { items: [{ monitorId: deletedMonitorId, enabled: true, sortOrder: 0 }] },
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any) // links query
      .mockReturnValueOnce(selectOrderByRows([]) as any) // config_policy_monitors — cascade-emptied
      .mockReturnValueOnce(selectLimitRows([link]) as any) // link.inlineSettings re-read for `inheritance`
      .mockReturnValueOnce(selectLimitRows([]) as any); // missing normalized settings do not create an override

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as { items: unknown[] };

    expect(settings).toEqual({ items: [], inheritance: 'cumulative' });
    expect(JSON.stringify(settings)).not.toContain(deletedMonitorId);
  });
});

describe("validateFeaturePolicyExists — 'monitors' is inline-only", () => {
  it('rejects a featurePolicyId exactly like monitoring/event_log/vulnerability', async () => {
    const res = await validateFeaturePolicyExists('monitors', 'some-policy-id', {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('rejects it for a partner-wide policy too', async () => {
    const res = await validateFeaturePolicyExists('monitors', 'some-policy-id', {
      orgId: null,
      partnerId: 'partner-1',
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const res = await validateFeaturePolicyExists('monitors', null, {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(true);
  });
});

describe('removeFeatureLink — settings owner retention', () => {
  it.each([
    ['monitors', 'cumulative', 45],
    ['monitors', 'replace', null],
    ['monitoring', 'cumulative', 120],
  ] as const)('retains %s %s settings=%s', async (featureType, inheritance, interval) => {
    const link = { id: 'link-mon', configPolicyId: 'policy-1', featureType,
      inlineSettings: { items: [{ monitorId: MONITOR_ID_1 }], inheritance } };
    const lock = { from: vi.fn(), where: vi.fn(), for: vi.fn(async () => [link]) };
    lock.from.mockReturnValue(lock);
    lock.where.mockReturnValue(lock);
    const tx = {
      select: vi.fn().mockReturnValueOnce(lock).mockReturnValueOnce(
        selectLimitRows(interval === null ? [] : [{ checkIntervalSeconds: interval }])),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({ set: vi.fn((values) => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...link, ...values }]) })),
      })) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    const result = await removeFeatureLink('link-mon', 'policy-1');
    expect(tx.delete).not.toHaveBeenCalledWith(configPolicyFeatureLinks);
    if (featureType === 'monitors') {
      expect(tx.delete).toHaveBeenCalledWith(configPolicyMonitors);
      expect(result!.inlineSettings).toEqual({ items: [], inheritance, ...(interval === null ? {} : { checkIntervalSeconds: interval }) });
    } else {
      expect(tx.delete).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    }
    expect(result).toMatchObject({ id: 'link-mon', kept: true });
  });
});
