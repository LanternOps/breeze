import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorDefinitions, organizations, partners } from '../../db/schema';

const { tableRows, selectFrom, partnerAxisReads } = vi.hoisted(() => ({
  tableRows: new Map<unknown, Array<Record<string, unknown>>>(),
  selectFrom: vi.fn(),
  partnerAxisReads: vi.fn(),
}));

// A `db.select(...).from(table).where(eq(table.id, id)).limit(1)` fake: rows
// are keyed by table and filtered on the id the `eq` names.
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        selectFrom(table);
        return {
          where: (cond: { id: unknown }) => ({
            limit: async () => (tableRows.get(table) ?? []).filter((row) => row.id === cond.id),
          }),
        };
      },
    }),
  },
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (_col: unknown, id: unknown) => ({ id }),
}));

vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: async <T>(fn: () => Promise<T>) => {
    partnerAxisReads();
    return fn();
  },
}));

import { createLifecycleLoader, legacyLifecycleValues, loadAlertLifecycle } from './resolve';

const PARTNER = 'p0000000-0000-4000-8000-000000000000';
const ORG_A = 'a0000000-0000-4000-8000-000000000000';
const ORG_B = 'b0000000-0000-4000-8000-000000000000';
const MONITOR = 'm0000000-0000-4000-8000-000000000000';

function partnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PARTNER, alertAutoResolve: true, alertRearmMode: 'after_delay',
    alertRearmDelayMinutes: 60, alertCooldownMinutes: 10, ...overrides,
  };
}

function orgRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, partnerId: PARTNER, alertAutoResolve: null, alertRearmMode: null,
    alertRearmDelayMinutes: null, alertCooldownMinutes: null, ...overrides,
  };
}

function monitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR, orgId: null, partnerId: PARTNER, autoResolve: null, cooldownMinutes: null,
    rearmMode: null, rearmDelayMinutes: null, ...overrides,
  } as unknown as typeof monitorDefinitions.$inferSelect;
}

const managedRule = { managedByMonitorId: MONITOR, overrideSettings: null };
const template = { autoResolve: false, cooldownMinutes: 5 };

beforeEach(() => {
  tableRows.clear();
  selectFrom.mockClear();
  partnerAxisReads.mockClear();
  tableRows.set(partners, [partnerRow()]);
  tableRows.set(organizations, [orgRow(ORG_A, { alertCooldownMinutes: 30 }), orgRow(ORG_B)]);
});

describe('loadAlertLifecycle', () => {
  it("resolves against the device's org, not the monitor owner", async () => {
    // One partner-wide monitor (owned by the partner, no org) reaching two orgs
    // with different overrides: each device gets ITS org's value.
    const load = createLifecycleLoader();
    const monitor = monitorRow();
    const forA = await load({ rule: managedRule, template, monitor, deviceOrgId: ORG_A });
    const forB = await load({ rule: managedRule, template, monitor, deviceOrgId: ORG_B });

    expect(forA.cooldownMinutes).toBe(30);
    expect(forA.sources.cooldownMinutes).toBe('org');
    expect(forB.cooldownMinutes).toBe(10);
    expect(forB.sources.cooldownMinutes).toBe('partner');
    // The compiled template's copy (5/false) is never the runtime answer.
    expect(forA.autoResolve).toBe(true);
    expect(forA.sources.autoResolve).toBe('partner');
    expect(forB).toMatchObject({ rearmMode: 'after_delay', rearmDelayMinutes: 60 });
  });

  it('a monitor override beats the org override', async () => {
    const load = createLifecycleLoader();
    const resolved = await load({
      rule: managedRule, template, monitor: monitorRow({ cooldownMinutes: 0, rearmMode: 'new_evidence' }), deviceOrgId: ORG_A,
    });
    expect(resolved.cooldownMinutes).toBe(0);
    expect(resolved.sources.cooldownMinutes).toBe('monitor');
    expect(resolved.rearmMode).toBe('new_evidence');
    expect(resolved.rearmDelayMinutes).toBeNull();
  });

  it('org and partner rows are read once per sweep', async () => {
    const load = createLifecycleLoader();
    const monitor = monitorRow();
    for (let i = 0; i < 5; i++) {
      await load({ rule: managedRule, template, monitor, deviceOrgId: ORG_A });
    }
    await load({ rule: managedRule, template, monitor, deviceOrgId: ORG_B });

    const reads = (table: unknown) => selectFrom.mock.calls.filter(([t]) => t === table).length;
    expect(reads(organizations)).toBe(2); // ORG_A once, ORG_B once
    expect(reads(partners)).toBe(1); // both orgs share the partner
    expect(partnerAxisReads).toHaveBeenCalledTimes(1);
  });

  it('reads the partner row through the partner-axis visibility escape', async () => {
    // partners RLS hides the row from org-scoped callers; a plain read would
    // silently collapse every inherited value to the built-in default.
    await loadAlertLifecycle({ rule: managedRule, template, monitor: monitorRow(), deviceOrgId: ORG_B });
    expect(partnerAxisReads).toHaveBeenCalledTimes(1);
  });

  it('loads the monitor row when the caller did not pass one', async () => {
    tableRows.set(monitorDefinitions, [monitorRow({ cooldownMinutes: 45 })]);
    const resolved = await loadAlertLifecycle({ rule: managedRule, template, deviceOrgId: ORG_B });
    expect(resolved.cooldownMinutes).toBe(45);
    expect(resolved.sources.cooldownMinutes).toBe('monitor');
  });

  it('a monitor-managed rule whose monitor is gone still inherits org → partner', async () => {
    const resolved = await loadAlertLifecycle({ rule: managedRule, template, monitor: null, deviceOrgId: ORG_A });
    expect(resolved.cooldownMinutes).toBe(30);
    expect(resolved.sources.cooldownMinutes).toBe('org');
  });

  it('legacy rule uses template/override values', async () => {
    const resolved = await loadAlertLifecycle({
      rule: { managedByMonitorId: null, overrideSettings: { cooldownMinutes: 15 } },
      template: { autoResolve: true, cooldownMinutes: 5 },
      deviceOrgId: ORG_A,
    });
    expect(resolved).toMatchObject({ autoResolve: true, cooldownMinutes: 15, rearmMode: 'new_evidence', rearmDelayMinutes: null });
    expect(resolved.sources).toMatchObject({ autoResolve: 'legacy', cooldownMinutes: 'legacy', rearmMode: 'builtin' });
    // OD8: a legacy rule never consults the org or partner.
    expect(selectFrom).not.toHaveBeenCalled();
  });
});

describe('legacyLifecycleValues', () => {
  it('rule override ?? template ?? built-in, with 0 and false as real values', () => {
    expect(legacyLifecycleValues({ overrideSettings: { cooldownMinutes: 0, autoResolve: false } }, { autoResolve: true, cooldownMinutes: 9 }))
      .toEqual({ autoResolve: false, cooldownMinutes: 0 });
    expect(legacyLifecycleValues({ overrideSettings: null }, { autoResolve: true, cooldownMinutes: 9 }))
      .toEqual({ autoResolve: true, cooldownMinutes: 9 });
    expect(legacyLifecycleValues({ overrideSettings: null }, null)).toEqual({ autoResolve: false, cooldownMinutes: 5 });
  });

  it('ignores an override of the wrong type instead of trusting the cast', () => {
    expect(legacyLifecycleValues({ overrideSettings: { cooldownMinutes: '30', autoResolve: 'yes' } }, { autoResolve: true, cooldownMinutes: 9 }))
      .toEqual({ autoResolve: true, cooldownMinutes: 9 });
  });
});
