import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * services/wisp/partnerSettings.ts — the partner's Wisp enable switch (W08
 * Task 6, w00 A35). The write is partner-wide state (epic #2135), so the
 * service refuses a caller without canManagePartnerWidePolicies before any
 * database access. The reconcile pauses ACTIVE grants with
 * 'partner_disabled' and resumes ONLY grants paused for that reason.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const inserts: Array<{ table: unknown; values: unknown; conflict?: { target: unknown; set: Record<string, unknown> } }> = [];
  const selects: Array<{ table?: unknown; where?: unknown }> = [];
  const selectChain = (): Record<string, unknown> => {
    const rec: (typeof selects)[number] = {};
    selects.push(rec);
    const p: Record<string, unknown> = {};
    p.from = vi.fn((t: unknown) => { rec.table = t; return p; });
    p.where = vi.fn((w: unknown) => { rec.where = w; return p; });
    for (const m of ['limit', 'orderBy']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const next = results.shift() ?? [];
      return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(res, rej);
    };
    return p;
  };
  const insertChain = (table: unknown): Record<string, unknown> => {
    const rec: (typeof inserts)[number] = { table, values: undefined };
    inserts.push(rec);
    const p: Record<string, unknown> = {};
    p.values = vi.fn((v: unknown) => { rec.values = v; return p; });
    p.onConflictDoUpdate = vi.fn((c: { target: unknown; set: Record<string, unknown> }) => { rec.conflict = c; return p; });
    p.returning = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    results,
    inserts,
    selects,
    db: { select: vi.fn(() => selectChain()), insert: vi.fn((t: unknown) => insertChain(t)) },
    afterCommit: [] as Array<{ label: string; work: () => unknown }>,
    systemDepth: 0,
    systemCalls: 0,
    pauseGrant: vi.fn(async (..._a: unknown[]) => undefined),
    resumeGrant: vi.fn(async (..._a: unknown[]) => undefined),
    captureException: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runAfterDbContextCommit: (label: string, work: () => unknown) => { h.afterCommit.push({ label, work }); },
}));
vi.mock('./grantAuthority', () => ({
  inSystemContext: async (fn: () => Promise<unknown>) => {
    h.systemCalls += 1;
    h.systemDepth += 1;
    try { return await fn(); } finally { h.systemDepth -= 1; }
  },
}));
vi.mock('./grants', () => ({ pauseGrant: h.pauseGrant, resumeGrant: h.resumeGrant }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import { wispPartnerNudgeSettings } from '../../db/schema/wispNudgePreferences';
import { wispGrants } from '../../db/schema/wisp';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { getPartnerSettings, reconcilePartnerDisabled, setPartnerEnabled } from './partnerSettings';

const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '11111111-1111-4111-8111-111111111111';
const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';
const auth = (o: Record<string, unknown> = {}) =>
  ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user: { id: USER }, ...o }) as never;

const dialect = new PgDialect();
const render = (where: unknown) => dialect.sqlToQuery(where as SQL);

beforeEach(() => {
  h.results.length = 0;
  h.inserts.length = 0;
  h.selects.length = 0;
  h.afterCommit.length = 0;
  h.systemDepth = 0;
  h.systemCalls = 0;
  vi.clearAllMocks();
  h.pauseGrant.mockImplementation(async () => undefined);
  h.resumeGrant.mockImplementation(async () => undefined);
});

describe('getPartnerSettings', () => {
  it('a missing row means enabled, with no urgent-capable severities', async () => {
    await expect(getPartnerSettings(PARTNER)).resolves.toEqual({ enabled: true, urgentCapableSeverities: [] });
    expect(h.selects[0]!.table).toBe(wispPartnerNudgeSettings);
    expect(render(h.selects[0]!.where).params).toEqual([PARTNER]);
  });

  it('returns the stored switch and the cleaned severities from ONE read', async () => {
    h.results.push([{ enabled: false, urgentCapableSeverities: ['high', 'critical', 'high'] }]);
    await expect(getPartnerSettings(PARTNER)).resolves.toEqual({ enabled: false, urgentCapableSeverities: ['high'] });
    expect(h.db.select).toHaveBeenCalledTimes(1);
  });
});

describe('setPartnerEnabled', () => {
  it('refuses a partner user WITHOUT full partner org access before any database access', async () => {
    await expect(setPartnerEnabled(auth({ partnerOrgAccess: 'selected' }), false)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.afterCommit).toHaveLength(0);
  });

  it('refuses an organization-scope caller and a partner-scope caller with no partnerId', async () => {
    await expect(setPartnerEnabled(auth({ scope: 'organization' }), false)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    await expect(setPartnerEnabled(auth({ partnerId: null }), false)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('upserts the switch on the caller\'s own partner, records the author, keeps the severities intact', async () => {
    h.results.push([{ enabled: false }]);
    await expect(setPartnerEnabled(auth(), false)).resolves.toEqual({ enabled: false });
    const [ins] = h.inserts;
    expect(ins!.table).toBe(wispPartnerNudgeSettings);
    expect(ins!.values).toEqual({ partnerId: PARTNER, enabled: false, updatedByUserId: USER });
    expect(ins!.conflict!.target).toBe(wispPartnerNudgeSettings.partnerId);
    expect(Object.keys(ins!.conflict!.set).sort()).toEqual(['enabled', 'updatedAt', 'updatedByUserId']);
    expect(ins!.conflict!.set).toMatchObject({ enabled: false, updatedByUserId: USER });
  });

  it('schedules the partner reconcile after the write commits (not inside the uncommitted transaction)', async () => {
    h.results.push([{ enabled: false }]);
    await setPartnerEnabled(auth(), false);
    // Nothing reconciled yet: the switch is not committed.
    expect(h.pauseGrant).not.toHaveBeenCalled();
    expect(h.afterCommit).toHaveLength(1);
    // After commit: the reconcile reads the switch and pauses the active grants.
    h.results.push([{ enabled: false, urgentCapableSeverities: [] }], [{ id: G1 }]);
    await h.afterCommit[0]!.work();
    expect(h.pauseGrant).toHaveBeenCalledWith(G1, 'partner_disabled', { onlyFromActive: true });
  });

  it('a reconcile failure after the write is logged and reported, never thrown (the tick retries)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.results.push([{ enabled: false }]);
    await expect(setPartnerEnabled(auth(), false)).resolves.toEqual({ enabled: false });
    const boom = new Error('db down');
    h.results.push(boom as never);
    await expect(Promise.resolve(h.afterCommit[0]!.work())).resolves.toBeUndefined();
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ component: 'wisp.partnerSettings' }));
    err.mockRestore();
  });
});

describe('reconcilePartnerDisabled', () => {
  it('disabled ⇒ every ACTIVE unexpired grant of the partner is paused partner_disabled (onlyFromActive), reads in system context', async () => {
    h.results.push([{ enabled: false, urgentCapableSeverities: [] }], [{ id: G1 }, { id: G2 }]);
    let depthAtSelect = -1;
    h.db.select.mockImplementationOnce((() => { depthAtSelect = h.systemDepth; return (h.db.select.getMockImplementation() as () => unknown)(); }) as never);
    await expect(reconcilePartnerDisabled(PARTNER)).resolves.toEqual({ paused: 2, resumed: 0 });
    expect(h.systemCalls).toBeGreaterThanOrEqual(1);
    expect(depthAtSelect).toBe(1);
    expect(h.pauseGrant).toHaveBeenCalledTimes(2);
    expect(h.pauseGrant).toHaveBeenCalledWith(G1, 'partner_disabled', { onlyFromActive: true });
    expect(h.pauseGrant).toHaveBeenCalledWith(G2, 'partner_disabled', { onlyFromActive: true });
    expect(h.resumeGrant).not.toHaveBeenCalled();

    const grantsRead = h.selects.find((s) => s.table === wispGrants)!;
    const q = render(grantsRead.where);
    expect(q.sql).toMatch(/"wisp_grants"."partner_id" = \$\d/);
    expect(q.sql).toMatch(/"wisp_grants"."status" = \$\d/);
    expect(q.sql).toMatch(/"wisp_grants"."expires_at" > \$\d/);
    expect(q.params).toEqual(expect.arrayContaining([PARTNER, 'active']));
    expect(q.sql).not.toMatch(/paused_reason/);
  });

  it('enabled (or a missing row) ⇒ resumes ONLY grants paused partner_disabled, by CAS on that reason', async () => {
    h.results.push([], [{ id: G1 }]);
    await expect(reconcilePartnerDisabled(PARTNER)).resolves.toEqual({ paused: 0, resumed: 1 });
    expect(h.resumeGrant).toHaveBeenCalledExactlyOnceWith(G1, 'partner_disabled');
    expect(h.pauseGrant).not.toHaveBeenCalled();

    const q = render(h.selects.find((s) => s.table === wispGrants)!.where);
    expect(q.params).toEqual(expect.arrayContaining([PARTNER, 'paused', 'partner_disabled']));
    // Never user_paused, never entitlement_lost, never any other reason.
    expect(q.params).not.toContain('user_paused');
    expect(q.params).not.toContain('entitlement_lost');
  });

  it('a failing grant is logged, reported and not counted; the rest still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.results.push([{ enabled: false, urgentCapableSeverities: [] }], [{ id: G1 }, { id: G2 }]);
    const boom = new Error('pause failed');
    h.pauseGrant.mockRejectedValueOnce(boom);
    await expect(reconcilePartnerDisabled(PARTNER)).resolves.toEqual({ paused: 1, resumed: 0 });
    expect(h.pauseGrant).toHaveBeenCalledWith(G2, 'partner_disabled', { onlyFromActive: true });
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ component: 'wisp.partnerSettings', op: 'reconcile_grant_update' }));
    err.mockRestore();
  });

  it('no grants to change ⇒ no pause or resume calls', async () => {
    h.results.push([{ enabled: true, urgentCapableSeverities: [] }], []);
    await expect(reconcilePartnerDisabled(PARTNER)).resolves.toEqual({ paused: 0, resumed: 0 });
    expect(h.pauseGrant).not.toHaveBeenCalled();
    expect(h.resumeGrant).not.toHaveBeenCalled();
  });
});
