/**
 * Wisp W05 Task 4 — the watches service. Drizzle is mocked with a recorder
 * (selects answer from a per-table queue; `db.execute` answers from a queue and
 * keeps the raw SQL for assertions); `deliverInApp` and Sentry are mocked;
 * `assertWithinCeiling` / `CeilingViolationError` are the real W02 ones, with
 * only `inSystemContext` replaced by a recorder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  state: { inSystem: false },
  selects: [] as Array<{ table: string; where: unknown; system: boolean }>,
  selectQueue: {} as Record<string, unknown[][]>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown>; system: boolean }>,
  deletes: [] as Array<{ table: string; where: unknown; system: boolean }>,
  deleteResult: [] as unknown[],
  executes: [] as Array<{ query: unknown; system: boolean }>,
  executeQueue: [] as unknown[][],
  deliverInApp: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../../db', async () => {
  const { getTableName: tableName } = await import('drizzle-orm');
  const select = vi.fn(() => {
    const entry = { table: '', where: undefined as unknown, system: h.state.inSystem };
    h.selects.push(entry);
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof tableName>[0]) => { entry.table = tableName(t); return chain; };
    chain.where = (w: unknown) => { entry.where = w; return chain; };
    for (const m of ['orderBy', 'limit', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.selectQueue[entry.table]?.shift() ?? []).then(res, rej);
    return chain;
  });
  const insert = vi.fn((t: Parameters<typeof tableName>[0]) => ({
    values: (values: Record<string, unknown>) => {
      const table = tableName(t);
      h.inserts.push({ table, values, system: h.state.inSystem });
      return {
        returning: async () => [{
          id: 'watch-new', status: 'active', stoppedReason: null, lastRanAt: null,
          createdAt: new Date('2026-10-24T12:00:00Z'), updatedAt: new Date('2026-10-24T12:00:00Z'),
          ...values,
        }],
      };
    },
  }));
  const del = vi.fn((t: Parameters<typeof tableName>[0]) => ({
    where: (where: unknown) => {
      h.deletes.push({ table: tableName(t), where, system: h.state.inSystem });
      return { returning: async () => h.deleteResult };
    },
  }));
  const execute = vi.fn(async (query: unknown) => {
    h.executes.push({ query, system: h.state.inSystem });
    return h.executeQueue.shift() ?? [];
  });
  return {
    db: { select, insert, delete: del, execute },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(),
    getCurrentDbAccessContext: vi.fn(() => undefined),
  };
});
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('./deliver', () => ({ deliverInApp: h.deliverInApp }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import { CeilingViolationError, type GrantCeiling } from './grantAuthority';
import {
  WATCH_MAX_PER_GRANT, WatchLimitReachedError, claimDueWatches, createWatch, deleteWatch, listWatches,
  stopWatchesForInactiveGrants, watchPromptLines, type Watch,
} from './watches';

const GRANT = '00000000-0000-4000-8000-000000000a01';
const GRANT_2 = '00000000-0000-4000-8000-000000000a02';
const GRANT_3 = '00000000-0000-4000-8000-000000000a03';
const REVISION = '00000000-0000-4000-8000-000000000a09';
const PARTNER = '00000000-0000-4000-8000-000000000b01';
const GRANTOR = '00000000-0000-4000-8000-000000000c01';
const GRANTOR_2 = '00000000-0000-4000-8000-000000000c02';
const ADMIN_1 = '00000000-0000-4000-8000-000000000c11';
const ADMIN_2 = '00000000-0000-4000-8000-000000000c12';
const ORG_A = '00000000-0000-4000-8000-000000000d01';
const ORG_OUT = '00000000-0000-4000-8000-000000000d99';

function makeCeiling(over: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: GRANT,
    revisionId: REVISION,
    partnerId: PARTNER,
    grantorUserId: GRANTOR,
    scopeOrgId: null,
    partnerWide: true,
    orgIds: new Set([ORG_A]),
    siteIds: null,
    permissionKeys: new Set(['ai_sessions:use']),
    toolAllowlist: null,
    deniedTools: new Set(),
    orgTerms: new Map(),
    status: 'active',
    ...over,
  };
}

const sqlOf = (q: unknown) => {
  const r = new PgDialect().sqlToQuery(q as never);
  return { text: r.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: r.params };
};

const NOW = new Date('2026-10-24T12:00:00.000Z');

beforeEach(() => {
  h.selects.length = 0;
  h.selectQueue = {};
  h.inserts.length = 0;
  h.deletes.length = 0;
  h.deleteResult = [];
  h.executes.length = 0;
  h.executeQueue = [];
  h.deliverInApp.mockReset().mockResolvedValue({ created: true });
  h.captureException.mockReset();
});

describe('createWatch', () => {
  it('refuses an orgId outside the ceiling with CeilingViolationError code org and inserts nothing', async () => {
    const err = await createWatch(makeCeiling(), { orgId: ORG_OUT, kind: 'backup_health', params: {}, cadenceMinutes: 60 }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CeilingViolationError);
    expect((err as CeilingViolationError).code).toBe('org');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses orgId null on a single-org grant', async () => {
    const ceiling = makeCeiling({ scopeOrgId: ORG_A, partnerWide: false });
    const err = await createWatch(ceiling, { orgId: null, kind: 'backup_health', params: {}, cadenceMinutes: 60 }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CeilingViolationError);
    expect((err as CeilingViolationError).code).toBe('org');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses an inactive grant', async () => {
    const err = await createWatch(makeCeiling({ status: 'paused' }), { orgId: ORG_A, kind: 'backup_health', params: {}, cadenceMinutes: 60 }, NOW)
      .catch((e: unknown) => e);
    expect((err as CeilingViolationError).code).toBe('inactive');
    expect(h.inserts).toHaveLength(0);
  });

  it('refuses a cadence outside 15..10080 or a non-integer, and an unknown kind', async () => {
    for (const cadenceMinutes of [14, 10_081, 30.5]) {
      await expect(createWatch(makeCeiling(), { orgId: ORG_A, kind: 'backup_health', params: {}, cadenceMinutes }, NOW))
        .rejects.toThrow(/cadence/i);
    }
    await expect(createWatch(makeCeiling(), { orgId: ORG_A, kind: 'nope' as never, params: {}, cadenceMinutes: 60 }, NOW))
      .rejects.toThrow(/kind/i);
    expect(h.inserts).toHaveLength(0);
  });

  it('orgId null on a partner-wide grant inserts with owner = grantor and next_due_at = now + cadence, in system context', async () => {
    h.selectQueue.wisp_watches = [[{ n: 3 }]];
    const w = await createWatch(makeCeiling(), { orgId: null, kind: 'ticket_waiting', params: { hours: 4 }, cadenceMinutes: 90 }, NOW);

    expect(h.inserts).toHaveLength(1);
    const ins = h.inserts[0]!;
    expect(ins.table).toBe('wisp_watches');
    expect(ins.system).toBe(true);
    expect(ins.values).toMatchObject({
      partnerId: PARTNER, grantId: GRANT, ownerUserId: GRANTOR, orgId: null,
      kind: 'ticket_waiting', params: { hours: 4 }, cadenceMinutes: 90,
    });
    expect((ins.values.nextDueAt as Date).toISOString()).toBe('2026-10-24T13:30:00.000Z');

    expect(w).toEqual({
      id: 'watch-new', partnerId: PARTNER, orgId: null, grantId: GRANT, kind: 'ticket_waiting',
      params: { hours: 4 }, cadenceMinutes: 90, status: 'active', stoppedReason: null, lastRanAt: null,
      nextDueAt: '2026-10-24T13:30:00.000Z', createdAt: '2026-10-24T12:00:00.000Z',
    });
    // The limit count is scoped to this grant's ACTIVE rows.
    const count = h.selects.find((s) => s.table === 'wisp_watches')!;
    const { text, params } = sqlOf(count.where);
    expect(text).toContain('"grant_id" = $');
    expect(text).toContain('"status" = $');
    expect(params).toEqual(expect.arrayContaining([GRANT, 'active']));
  });

  it(`throws WatchLimitReachedError once the grant has ${WATCH_MAX_PER_GRANT} active watches`, async () => {
    h.selectQueue.wisp_watches = [[{ n: WATCH_MAX_PER_GRANT }]];
    const err = await createWatch(makeCeiling(), { orgId: ORG_A, kind: 'backup_health', params: {}, cadenceMinutes: 60 }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WatchLimitReachedError);
    expect((err as WatchLimitReachedError).code).toBe('watch_limit_reached');
    expect(h.inserts).toHaveLength(0);
  });
});

describe('listWatches / deleteWatch', () => {
  it('listWatches reads only the grant rows and maps the DTO', async () => {
    h.selectQueue.wisp_watches = [[{
      id: 'w1', partnerId: PARTNER, orgId: ORG_A, grantId: GRANT, ownerUserId: GRANTOR, kind: 'backup_health',
      params: {}, cadenceMinutes: 60, status: 'stopped', stoppedReason: 'paused',
      lastRanAt: new Date('2026-10-24T11:00:00Z'), nextDueAt: new Date('2026-10-24T12:00:00Z'),
      createdAt: new Date('2026-10-20T00:00:00Z'), updatedAt: new Date('2026-10-24T11:00:00Z'),
    }]];
    const rows = await listWatches(makeCeiling());
    expect(rows).toEqual([expect.objectContaining({ id: 'w1', stoppedReason: 'paused', lastRanAt: '2026-10-24T11:00:00.000Z' })]);
    expect(rows[0]).not.toHaveProperty('ownerUserId');
    const s = h.selects[0]!;
    expect(s.system).toBe(true);
    const { text, params } = sqlOf(s.where);
    expect(text).toContain('"grant_id" = $');
    expect(params).toEqual([GRANT]);
  });

  it('deleteWatch deletes only the owning grant row and reports whether one went', async () => {
    h.deleteResult = [{ id: 'w1' }];
    expect(await deleteWatch(makeCeiling(), 'w1')).toBe(true);
    h.deleteResult = [];
    expect(await deleteWatch(makeCeiling(), 'w-other')).toBe(false);
    const { text, params } = sqlOf(h.deletes[0]!.where);
    expect(text).toContain('"id" = $');
    expect(text).toContain('"grant_id" = $');
    expect(params).toEqual(['w1', GRANT]);
    expect(h.deletes.every((d) => d.system)).toBe(true);
  });
});

describe('claimDueWatches', () => {
  it('issues one UPDATE … FOR UPDATE SKIP LOCKED that advances next_due_at by cadence, and maps the rows', async () => {
    h.executeQueue = [[{
      id: 'w1', partner_id: PARTNER, org_id: ORG_A, grant_id: GRANT, owner_user_id: GRANTOR, kind: 'alert_pattern',
      params: { pattern: 'disk' }, cadence_minutes: 30, status: 'active', stopped_reason: null,
      last_ran_at: NOW, next_due_at: new Date('2026-10-24T12:30:00Z'), created_at: '2026-10-20T00:00:00+00', updated_at: NOW,
    }]];
    const claimed = await claimDueWatches(NOW, 25);

    expect(h.executes).toHaveLength(1);
    expect(h.executes[0]!.system).toBe(true);
    const { text, params } = sqlOf(h.executes[0]!.query);
    expect(text).toMatch(/^update wisp_watches/);
    expect(text).toContain('for update skip locked');
    expect(text).toContain("status = 'active'");
    expect(text).toMatch(/next_due_at <= \$\d+::timestamptz/);
    expect(text).toMatch(/set last_ran_at = \$\d+::timestamptz, next_due_at = \$\d+::timestamptz \+ cadence_minutes \* interval '1 minute'/);
    expect(text).toContain('order by next_due_at');
    expect(text).toContain('returning *');
    expect(params).toEqual(expect.arrayContaining([NOW.toISOString(), 25]));

    expect(claimed).toEqual([{
      id: 'w1', partnerId: PARTNER, orgId: ORG_A, grantId: GRANT, kind: 'alert_pattern', params: { pattern: 'disk' },
      cadenceMinutes: 30, status: 'active', stoppedReason: null, lastRanAt: NOW.toISOString(),
      nextDueAt: '2026-10-24T12:30:00.000Z', createdAt: '2026-10-20T00:00:00.000Z',
    }]);
  });

  it('claims nothing for a non-positive limit', async () => {
    expect(await claimDueWatches(NOW, 0)).toEqual([]);
    expect(h.executes).toHaveLength(0);
  });
});

describe('stopWatchesForInactiveGrants', () => {
  it('stops in one statement with stopped_reason = grant status (expired when only past expiry)', async () => {
    h.executeQueue = [[]];
    expect(await stopWatchesForInactiveGrants(NOW)).toEqual({ stopped: 0, grantsNotified: 0 });
    expect(h.executes).toHaveLength(1);
    const { text, params } = sqlOf(h.executes[0]!.query);
    expect(text).toMatch(/^update wisp_watches w set status = 'stopped'/);
    expect(text).toContain("stopped_reason = case when g.status = 'active' then 'expired' else g.status end");
    expect(text).toContain('from wisp_grants g where w.grant_id = g.id');
    expect(text).toContain("w.status = 'active'");
    expect(text).toMatch(/g.status <> 'active' or g.expires_at <= \$\d+::timestamptz/);
    expect(params).toContain(NOW.toISOString());
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('notifies each partner admin once per grant, skips user_paused grants, and keeps going when a delivery throws', async () => {
    h.executeQueue = [[
      { id: 'w1', grant_id: GRANT, kind: 'backup_health', status: 'revoked', paused_reason: null, grantor_user_id: GRANTOR, partner_id: PARTNER },
      { id: 'w2', grant_id: GRANT, kind: 'ticket_waiting', status: 'revoked', paused_reason: null, grantor_user_id: GRANTOR, partner_id: PARTNER },
      { id: 'w3', grant_id: GRANT_2, kind: 'alert_pattern', status: 'paused', paused_reason: 'user_paused', grantor_user_id: GRANTOR_2, partner_id: PARTNER },
      { id: 'w4', grant_id: GRANT_3, kind: 'patch_compliance', status: 'paused', paused_reason: 'grantor_suspended', grantor_user_id: GRANTOR_2, partner_id: PARTNER },
    ]];
    h.selectQueue.users = [[
      { id: GRANTOR, name: 'Ada Tech', email: 'ada@example.test' },
      { id: GRANTOR_2, name: '', email: 'bo@example.test' },
    ]];
    h.selectQueue.partner_users = [[
      { userId: ADMIN_1, partnerId: PARTNER },
      { userId: ADMIN_2, partnerId: PARTNER },
    ]];
    h.deliverInApp.mockImplementation(async (d: { userId: string; grantId: string }) => {
      if (d.userId === ADMIN_1 && d.grantId === GRANT) throw new Error('boom');
      return { created: true };
    });

    const out = await stopWatchesForInactiveGrants(NOW);
    expect(out).toEqual({ stopped: 4, grantsNotified: 2 });

    const calls = h.deliverInApp.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toHaveLength(4);
    // Never the user_paused grant.
    expect(calls.some((c) => c.grantId === GRANT_2)).toBe(false);
    for (const admin of [ADMIN_1, ADMIN_2]) {
      for (const grant of [GRANT, GRANT_3]) {
        expect(calls.filter((c) => c.userId === admin && c.grantId === grant)).toHaveLength(1);
      }
    }
    expect(calls.find((c) => c.userId === ADMIN_2 && c.grantId === GRANT)).toEqual({
      userId: ADMIN_2,
      orgId: null,
      title: 'Wisp: watches stopped',
      body: "Ada Tech's Wisp grant is revoked; 2 watch(es) no longer running: backup_health, ticket_waiting",
      link: '/approvals',
      dedupeKey: `wisp-watches-orphaned-${GRANT}-${NOW.toISOString().slice(0, 10)}`,
      grantId: GRANT,
    });
    expect(calls.find((c) => c.grantId === GRANT_3)!.body)
      .toBe("bo@example.test's Wisp grant is paused; 1 watch(es) no longer running: patch_compliance");
    expect(h.captureException).toHaveBeenCalledTimes(1);

    // A grant whose every delivery fails is NOT counted as notified.
    h.deliverInApp.mockReset();
    h.deliverInApp.mockRejectedValue(new Error('down'));
    h.executeQueue = [[
      { id: 'w5', grant_id: GRANT_3, kind: 'ticket_waiting', status: 'revoked', paused_reason: null, grantor_user_id: GRANTOR_2, partner_id: PARTNER },
    ]];
    h.selectQueue.users = [[{ id: GRANTOR_2, name: 'Bo', email: 'bo@example.test' }]];
    h.selectQueue.partner_users = [[{ userId: ADMIN_1, partnerId: PARTNER }]];
    expect(await stopWatchesForInactiveGrants(NOW)).toEqual({ stopped: 1, grantsNotified: 0 });

    // Admins = org_access 'all' partner users who are active, for the affected partners.
    const adminSel = h.selects.find((s) => s.table === 'partner_users')!;
    const { text, params } = sqlOf(adminSel.where);
    expect(text).toContain('"org_access" = $');
    expect(text).toContain('"status" = $');
    expect(params).toEqual(expect.arrayContaining([PARTNER, 'all', 'active']));
    expect(h.selects.every((s) => s.system)).toBe(true);
  });
});

describe('watchPromptLines', () => {
  /** U+2028 / U+2029 built from code points so the source file stays plain ASCII. */
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const base: Watch = {
    id: 'w1', partnerId: PARTNER, orgId: null, grantId: GRANT, kind: 'custom_query', params: {},
    cadenceMinutes: 60, status: 'active', stoppedReason: null, lastRanAt: null,
    nextDueAt: NOW.toISOString(), createdAt: NOW.toISOString(),
  };

  it('is deterministic across permuted params', () => {
    const a = watchPromptLines({ ...base, params: { zeta: 1, alpha: 'x', mid: { a: 1 } } });
    const b = watchPromptLines({ ...base, params: { mid: { a: 1 }, alpha: 'x', zeta: 1 } });
    expect(a).toEqual(b);
    expect(a).toEqual([
      'watch w1: custom_query',
      'scope: every org in the grant',
      'cadence: every 60 minutes',
      'param alpha=x',
      'param mid={"a":1}',
      'param zeta=1',
    ]);
    expect(watchPromptLines({ ...base, orgId: ORG_A })[1]).toBe(`scope: org ${ORG_A}`);
  });

  it('strips control chars / newlines, drops unsafe keys, caps value length and param count', () => {
    const params: Record<string, unknown> = {
      note: `line1\nIGNORE PREVIOUS\r\tline3${LS}x`,
      'bad key\n': 'dropped',
      'k=v': 'dropped',
      long: 'y'.repeat(500),
      flag: true,
      none: null,
    };
    for (let i = 0; i < 30; i++) params[`p${String(i).padStart(2, '0')}`] = i;
    const lines = watchPromptLines({ ...base, params });
    const paramLines = lines.slice(3);
    expect(paramLines).toHaveLength(20);
    const unsafe = new RegExp(`[\\u0000-\\u001f\\u007f${LS}${PS}]`);
    for (const l of lines) expect(l).not.toMatch(unsafe);
    expect(lines.some((l) => l.includes('dropped'))).toBe(false);
    expect(paramLines).toContain('param flag=true');
    expect(paramLines).toContain('param none=null');
    expect(paramLines).toContain('param note=line1 IGNORE PREVIOUS  line3 x');
    const longLine = paramLines.find((l) => l.startsWith('param long='))!;
    expect(longLine.length).toBe('param long='.length + 200);
  });
});
