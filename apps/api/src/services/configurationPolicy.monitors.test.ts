import { describe, it, expect, vi } from 'vitest';

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
  listFeatureLinks,
  validateFeaturePolicyExists,
} from './configurationPolicy';
import { db } from '../db';
import { configPolicyAlertRules, configPolicyMonitors } from '../db/schema';

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
      insert: vi.fn(() => ({
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
      insert: vi.fn(() => ({
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

  it('rejects a non-uuid monitorId before any insert', async () => {
    const tx = {
      insert: vi.fn(() => ({
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
  function updateTx(existing: Record<string, unknown>) {
    const calls: Array<{ op: 'delete' | 'insert'; table: unknown; values?: any }> = [];
    const tx: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([existing])) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ ...existing }])),
          })),
        })),
      })),
      delete: vi.fn((table: unknown) => {
        calls.push({ op: 'delete', table });
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: any) => {
          calls.push({ op: 'insert', table, values });
          return Promise.resolve([]);
        }),
      })),
    };
    return { tx, calls };
  }

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
      .mockReturnValueOnce(selectLimitRows([link]) as any);

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
      .mockReturnValueOnce(selectLimitRows([link]) as any);

    const result = await listFeatureLinks('policy-1');
    // No normalized rows → assembleInlineSettings assembles straight from
    // config_policy_monitors (empty) rather than falling back to the link's
    // JSONB mirror.
    expect(result[0]!.inlineSettings).toEqual({ items: [], inheritance: 'cumulative' });
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
      .mockReturnValueOnce(selectLimitRows([link]) as any); // link.inlineSettings re-read for `inheritance`

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as { items: unknown[] };

    expect(settings.items).toEqual([]);
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

describe("addFeatureLink/updateFeatureLink — alert_rule delivery parity fields", () => {
  it('decompose carries escalationPolicyId and notificationChannelIds through to the row', async () => {
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
                    { id: 'link-ar', configPolicyId: 'policy-1', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: v.inlineSettings },
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

    await addFeatureLink('policy-1', 'alert_rule', null, {
      items: [
        {
          name: 'High CPU',
          conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }],
          escalationPolicyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          notificationChannelIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
        },
      ],
    });

    expect(normalizedRowValues[0]).toMatchObject({
      escalationPolicyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      notificationChannelIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    });
  });

  it('decompose defaults both delivery fields to null when omitted', async () => {
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
                    { id: 'link-ar', configPolicyId: 'policy-1', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: v.inlineSettings },
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

    await addFeatureLink('policy-1', 'alert_rule', null, {
      items: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }] }],
    });

    expect(normalizedRowValues[0].escalationPolicyId).toBeNull();
    expect(normalizedRowValues[0].notificationChannelIds).toBeNull();
  });

  it('assemble round-trips escalationPolicyId and notificationChannelIds', async () => {
    const link = {
      id: 'link-ar',
      configPolicyId: 'policy-1',
      featureType: 'alert_rule',
      featurePolicyId: null,
      inlineSettings: { items: [] },
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereRows([link]) as any) // links query
      .mockReturnValueOnce(
        selectOrderByRows([
          {
            name: 'High CPU',
            severity: 'medium',
            conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }],
            cooldownMinutes: 5,
            autoResolve: false,
            autoResolveConditions: null,
            titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
            messageTemplate: '{{ruleName}} condition met',
            escalationPolicyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            notificationChannelIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
            sortOrder: 0,
          },
        ]) as any
      );

    const result = await listFeatureLinks('policy-1');
    const settings = result[0]!.inlineSettings as { items: Array<Record<string, unknown>> };

    expect(settings.items[0]).toMatchObject({
      escalationPolicyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      notificationChannelIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    });
  });
});
