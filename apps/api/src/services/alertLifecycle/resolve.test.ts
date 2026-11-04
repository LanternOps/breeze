import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorDefinitions, organizations, partners } from '../../db/schema';

const { tableRows, selectFrom, partnerAxisReads, captureException } = vi.hoisted(() => ({
  tableRows: new Map<unknown, Array<Record<string, unknown>>>(),
  selectFrom: vi.fn(),
  partnerAxisReads: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../sentry', () => ({ captureException }));

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

import { createLifecycleLoader, hasMalformedLegacyCooldownOverride, legacyLifecycleValues, loadAlertLifecycle, readLifecycleSnapshot } from './resolve';

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
  captureException.mockClear();
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

  it("reads the device org's own partner, not any other partner row", async () => {
    const OTHER_PARTNER = 'q0000000-0000-4000-8000-000000000000';
    tableRows.set(partners, [
      partnerRow({ alertCooldownMinutes: 10 }),
      { ...partnerRow({ alertCooldownMinutes: 77 }), id: OTHER_PARTNER },
    ]);
    tableRows.set(organizations, [orgRow(ORG_B, { partnerId: OTHER_PARTNER })]);
    // The monitor is owned by PARTNER; the device's org belongs to OTHER_PARTNER.
    const resolved = await loadAlertLifecycle({ rule: managedRule, template, monitor: monitorRow(), deviceOrgId: ORG_B });
    expect(resolved.cooldownMinutes).toBe(77);
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

  it('reports an invisible device org once per sweep, not once per rule', async () => {
    tableRows.set(organizations, []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const load = createLifecycleLoader();
      for (let i = 0; i < 3; i++) {
        const resolved = await load({ rule: managedRule, template, monitor: monitorRow(), deviceOrgId: ORG_A });
        expect(resolved.sources.cooldownMinutes).toBe('builtin');
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException.mock.calls[0]![2]).toMatchObject({ errorId: 'alert-lifecycle-org-not-visible', deviceOrgId: ORG_A });
    } finally {
      warn.mockRestore();
    }
  });

  it("reports an org whose partner row is missing instead of silently using the built-in", async () => {
    tableRows.set(partners, []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resolved = await loadAlertLifecycle({ rule: managedRule, template, monitor: monitorRow(), deviceOrgId: ORG_B });
      expect(resolved.sources.autoResolve).toBe('builtin');
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException.mock.calls[0]![2]).toMatchObject({ errorId: 'alert-lifecycle-partner-missing', partnerId: PARTNER });
    } finally {
      warn.mockRestore();
    }
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

  it('ignores a negative or fractional override cooldown', () => {
    for (const bad of [-5, 2.5]) {
      expect(legacyLifecycleValues({ overrideSettings: { cooldownMinutes: bad } }, { autoResolve: true, cooldownMinutes: 9 }).cooldownMinutes)
        .toBe(9);
    }
  });
});

describe('hasMalformedLegacyCooldownOverride', () => {
  const legacy = (cooldownMinutes: unknown) => ({ managedByMonitorId: null, overrideSettings: { cooldownMinutes } });

  it.each(['invalid', '30', -1, 2.5, true, {}])('flags the override the loader would ignore: %j', (bad) => {
    expect(hasMalformedLegacyCooldownOverride(legacy(bad))).toBe(true);
  });

  it.each([0, 5, 20_000, null, undefined])('accepts a usable or absent override: %j', (ok) => {
    expect(hasMalformedLegacyCooldownOverride(legacy(ok))).toBe(false);
  });

  it('is false with no overrides, and for a managed rule, which never reads the rule override', () => {
    expect(hasMalformedLegacyCooldownOverride({ managedByMonitorId: null, overrideSettings: null })).toBe(false);
    expect(hasMalformedLegacyCooldownOverride({ managedByMonitorId: MONITOR, overrideSettings: { cooldownMinutes: 'invalid' } })).toBe(false);
  });
});

describe('readLifecycleSnapshot', () => {
  const sources = { autoResolve: 'partner', rearmMode: 'org', rearmDelayMinutes: 'org', cooldownMinutes: 'monitor' };
  const snapshot = (lifecycle: Record<string, unknown>) => ({
    lifecycle: { autoResolve: true, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5, sources, ...lifecycle },
  });

  it('reads a valid snapshot, keeping the cursor out of the values', () => {
    expect(readLifecycleSnapshot({ lifecycle: { ...snapshot({}).lifecycle, cursor: { root: {} } } })).toEqual({
      autoResolve: true, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5, sources,
    });
    expect(readLifecycleSnapshot(snapshot({ rearmMode: 'after_delay', rearmDelayMinutes: 30 }))?.rearmDelayMinutes).toBe(30);
    // A legacy template's cooldown is not capped at 1440.
    expect(readLifecycleSnapshot(snapshot({ cooldownMinutes: 2880 }))?.cooldownMinutes).toBe(2880);
  });

  it('a W1 context (cursor only) or no context has no snapshot', () => {
    expect(readLifecycleSnapshot({ lifecycle: { cursor: { root: {} } } })).toBeNull();
    expect(readLifecycleSnapshot(null)).toBeNull();
    expect(readLifecycleSnapshot({})).toBeNull();
  });

  it('rejects a snapshot that breaks the re-arm pair, the ranges or the source vocabulary', () => {
    const bad: Array<Record<string, unknown>> = [
      { rearmMode: 'after_delay', rearmDelayMinutes: null },
      { rearmMode: 'after_delay' , rearmDelayMinutes: undefined },
      { rearmMode: 'new_evidence', rearmDelayMinutes: 30 },
      { rearmMode: 'after_delay', rearmDelayMinutes: 0 },
      { rearmMode: 'after_delay', rearmDelayMinutes: 1.5 },
      { rearmMode: 'after_delay', rearmDelayMinutes: 1441 },
      { cooldownMinutes: 2.5 },
      { cooldownMinutes: -1 },
      { sources: { ...sources, cooldownMinutes: 'elsewhere' } },
      { sources: { autoResolve: 'partner' } },
    ];
    for (const lifecycle of bad) expect(readLifecycleSnapshot(snapshot(lifecycle)), JSON.stringify(lifecycle)).toBeNull();
  });
});
