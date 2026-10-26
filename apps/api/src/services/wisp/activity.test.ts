/**
 * Wisp W06 Task 14 — the derived activity timeline (w00 A31). Drizzle is
 * mocked: each `select().from(<table>)` chain resolves to the rows queued for
 * that table name (the mock does NOT evaluate SQL), and its WHERE is captured
 * so the tests can render it. The SQL ceiling / keyset predicates are pinned
 * by rendering; the in-process belts (assertWithinCeiling, keyset re-check)
 * are pinned by the returned items. `grantAuthority` is the real module with
 * only `inSystemContext` replaced by a pass-through recorder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: {} as Record<string, unknown[]>,
  wheres: {} as Record<string, unknown[]>,
}));

vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = vi.fn(() => {
    let table = '';
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => { table = getTableName(t); h.calls.push(`select:${table}`); return chain; };
    for (const m of ['leftJoin', 'innerJoin', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.where = (w: unknown) => { (h.wheres[table] ??= []).push(w); return chain; };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([...(h.rows[table] ?? [])]).then(res, rej);
    return chain;
  });
  return {
    db: { select },
    withDbTransaction: vi.fn((fn: () => Promise<unknown>) => fn()),
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grantAuthority')>();
  return {
    ...actual,
    inSystemContext: vi.fn((fn: () => Promise<unknown>) => { h.calls.push('system'); return fn(); }),
  };
});

import type { GrantCeiling } from './grantAuthority';
import {
  InvalidActivityCursorError,
  currentActivity,
  decodeActivityCursor,
  encodeActivityCursor,
  listActivity,
} from './activity';

const P1 = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const G1 = '99999999-9999-4999-8999-999999999999';
const R1 = '88888888-8888-4888-8888-888888888888';
const T1 = '77777777-7777-4777-8777-777777777777';

const ceiling = (over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: G1, revisionId: R1, partnerId: P1, grantorUserId: U1, scopeOrgId: null, partnerWide: false,
  orgIds: new Set([O1]), siteIds: null, permissionKeys: new Set(), toolAllowlist: null,
  deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...over,
});

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = (min: number) => new Date(Date.UTC(2026, 9, 24, 10, min, 0, 0));

const runRow = (n: number, orgId: string, at: Date, over: Record<string, unknown> = {}) => ({
  id: uid(n), orgId, orgName: orgId === O1 ? 'Greenwood' : 'Other Co', status: 'completed', summary: 'All quiet',
  costCents: 7, queuedAt: at, startedAt: at, finishedAt: at, ...over,
});
const concernRow = (n: number, orgId: string | null, at: Date, over: Record<string, unknown> = {}) => ({
  id: uid(n), orgId, summary: 'Backup failing on FS01', severity: 'high', status: 'open', outcome: null, updatedAt: at, ...over,
});
const intentRow = (n: number, orgId: string, at: Date) => ({
  id: uid(n), orgId, status: 'pending_approval', targetSummary: 'Restart Print Spooler on FS01', createdAt: at,
});
const memoryRow = (n: number, ownerKind: string, ownerOrgId: string | null, at: Date) => ({
  id: uid(n), ownerKind, ownerOrgId, blockType: 'org_fact', subjectKey: 'backup:vendor', status: 'unconfirmed', createdAt: at,
});
const notifRow = (n: number, orgId: string | null, at: Date, isBrief = false) => ({
  id: uid(n), orgId, title: isBrief ? 'Good morning' : 'Wisp needs you', message: 'Backup failing', link: `/ai/wisp/thread/${T1}`, isBrief, createdAt: at,
});

const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL);

beforeEach(() => {
  h.calls.length = 0;
  for (const k of Object.keys(h.rows)) delete h.rows[k];
  for (const k of Object.keys(h.wheres)) delete h.wheres[k];
});

describe('cursor', () => {
  it('round-trips (at, kind, id)', () => {
    const c = encodeActivityCursor({ at: '2026-10-24T10:00:00.123Z', kind: 'concern', id: uid(1) });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(c)).toEqual({ at: new Date('2026-10-24T10:00:00.123Z'), kind: 'concern', id: uid(1) });
  });

  it.each([
    ['not base64 garbage', '!!!'],
    ['two parts', Buffer.from('2026-10-24T10:00:00.000Z|concern').toString('base64url')],
    ['bad date', Buffer.from(`yesterday|concern|${uid(1)}`).toString('base64url')],
    ['bad kind', Buffer.from(`2026-10-24T10:00:00.000Z|bogus|${uid(1)}`).toString('base64url')],
    ['bad id', Buffer.from('2026-10-24T10:00:00.000Z|concern|x; drop table').toString('base64url')],
  ])('malformed (%s) → InvalidActivityCursorError from listActivity', async (_label, cursor) => {
    await expect(listActivity(ceiling(), { cursor })).rejects.toBeInstanceOf(InvalidActivityCursorError);
    expect(h.calls.filter((c) => c.startsWith('select:'))).toEqual([]);
  });
});

describe('listActivity — ceiling filter', () => {
  it('items from two orgs where the ceiling covers one → only that org’s items come back', async () => {
    h.rows.ai_agent_runs = [runRow(1, O1, t(1)), runRow(2, O2, t(2))];
    h.rows.wisp_concerns = [concernRow(3, O1, t(3)), concernRow(4, O2, t(4))];
    h.rows.action_intents = [intentRow(5, O1, t(5)), intentRow(6, O2, t(6))];
    h.rows.ai_memory_blocks = [memoryRow(7, 'org', O1, t(7)), memoryRow(8, 'org', O2, t(8))];
    h.rows.user_notifications = [notifRow(9, O1, t(9)), notifRow(10, O2, t(10))];

    const { items, nextCursor } = await listActivity(ceiling());

    expect(items.map((i) => i.id).sort()).toEqual([uid(1), uid(3), uid(5), uid(7), uid(9)]);
    expect(items.every((i) => i.orgId === O1)).toBe(true);
    expect(nextCursor).toBeNull();
    expect(h.calls[0]).toBe('system');

    // The SQL filter itself is pinned to the covered org (the belt is a second line).
    for (const table of ['ai_agent_runs', 'wisp_concerns', 'action_intents', 'ai_memory_blocks', 'user_notifications']) {
      const q = render(h.wheres[table]![0]);
      expect(q.params, table).toContain(O1);
      expect(q.params, table).not.toContain(O2);
    }
    expect(render(h.wheres.ai_agent_runs![0]).params).toContain(G1);
    expect(render(h.wheres.user_notifications![0]).params).toContain(U1);
    expect(render(h.wheres.user_notifications![0]).sql).toContain(`->> 'grantId'`);
  });

  it('builds each item field by field with the right kind, href and cost', async () => {
    h.rows.ai_agent_runs = [runRow(1, O1, t(1))];
    h.rows.wisp_concerns = [concernRow(2, O1, t(2), { summary: 'x'.repeat(300) })];
    h.rows.action_intents = [intentRow(3, O1, t(3))];
    h.rows.ai_memory_blocks = [memoryRow(4, 'org', O1, t(4))];
    h.rows.user_notifications = [notifRow(5, O1, t(5)), notifRow(6, null, t(6), true)];

    const { items } = await listActivity(ceiling(), { threadId: T1 });
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get(uid(1))).toEqual({
      id: uid(1), at: t(1).toISOString(), kind: 'assessment', orgId: O1, title: 'Checked Greenwood',
      detail: 'All quiet', href: `/ai-agents/runs/${uid(1)}`, costCents: 7,
    });
    const concern = byId.get(uid(2))!;
    expect(concern.kind).toBe('concern');
    expect(concern.title.length).toBeLessThanOrEqual(140);
    expect(concern.href).toBe(`/ai/wisp/thread/${T1}#concern=${uid(2)}`);
    expect(concern.costCents).toBeNull();
    expect(byId.get(uid(3))).toMatchObject({ kind: 'approval', href: `/approvals#intent-${uid(3)}`, orgId: O1 });
    const memory = byId.get(uid(4))!;
    expect(memory).toMatchObject({ kind: 'memory', orgId: O1, href: null });
    expect(memory.title).toContain('backup:vendor');
    expect(byId.get(uid(5))).toMatchObject({ kind: 'nudge', title: 'Wisp needs you', href: `/ai/wisp/thread/${T1}` });
    expect(byId.get(uid(6))).toMatchObject({ kind: 'brief', orgId: null });
    // newest first
    expect(items.map((i) => i.id)).toEqual([uid(6), uid(5), uid(4), uid(3), uid(2), uid(1)]);
  });

  it('concern href is null without a threadId', async () => {
    h.rows.wisp_concerns = [concernRow(2, O1, t(2))];
    const { items } = await listActivity(ceiling());
    expect(items[0]!.href).toBeNull();
  });

  it('org-NULL concerns need a partner-wide grant with full reach; org-NULL nudges/memory are the grantor’s own', async () => {
    const rows = () => {
      h.rows.wisp_concerns = [concernRow(1, null, t(1))];
      h.rows.ai_memory_blocks = [memoryRow(2, 'user', null, t(2)), memoryRow(3, 'partner', null, t(3))];
      h.rows.user_notifications = [notifRow(4, null, t(4))];
    };
    rows();
    const narrow = await listActivity(ceiling({ partnerWide: false }));
    expect(narrow.items.map((i) => i.id).sort()).toEqual([uid(2), uid(3), uid(4)]);
    expect(render(h.wheres.wisp_concerns![0]).sql).not.toContain('is null');

    rows();
    const wide = await listActivity(ceiling({ partnerWide: true }));
    expect(wide.items.map((i) => i.id).sort()).toEqual([uid(1), uid(2), uid(3), uid(4)]);
    expect(render(h.wheres.wisp_concerns![1]).sql).toContain('"wisp_concerns"."org_id" is null');
  });

  it('a site-restricted ceiling (or org membership) reads no org-bearing rows of that org', async () => {
    h.rows.ai_agent_runs = [runRow(1, O1, t(1)), runRow(2, O2, t(2))];
    h.rows.wisp_concerns = [concernRow(3, O1, t(3))];
    const restricted = ceiling({
      orgIds: new Set([O1, O2]),
      orgTerms: new Map([[O2, { permissionKeys: new Set(['*:*']), siteIds: new Set(['s1']) }]]),
    });
    const { items } = await listActivity(restricted);
    expect(items.map((i) => i.id).sort()).toEqual([uid(1), uid(3)]);
    expect(render(h.wheres.ai_agent_runs![0]).params).not.toContain(O2);

    h.calls.length = 0;
    const siteWide = await listActivity(ceiling({ siteIds: new Set(['s1']) }));
    expect(siteWide.items).toEqual([]);
    // no readable org and no partner level: the org-only sources are not even queried
    expect(h.calls).not.toContain('select:ai_agent_runs');
    expect(h.calls).not.toContain('select:action_intents');
    expect(h.calls).not.toContain('select:wisp_concerns');
  });
});

describe('listActivity — keyset pagination', () => {
  it('clamps limit to 1..100 and defaults to 50', async () => {
    h.rows.user_notifications = Array.from({ length: 120 }, (_, i) => notifRow(i + 1, null, new Date(t(0).getTime() + i * 1000)));
    expect((await listActivity(ceiling())).items).toHaveLength(50);
    expect((await listActivity(ceiling(), { limit: 500 })).items).toHaveLength(100);
    expect((await listActivity(ceiling(), { limit: 0 })).items).toHaveLength(1);
  });

  it('is stable: page 2 starts strictly after page 1, and a newer insert does not appear on page 2', async () => {
    // Ties on `at` across kinds and within a kind exercise the (at, kind, id) tiebreak.
    h.rows.ai_agent_runs = [runRow(1, O1, t(5)), runRow(2, O1, t(1))];
    h.rows.wisp_concerns = [concernRow(3, O1, t(5)), concernRow(4, O1, t(3))];
    h.rows.action_intents = [intentRow(5, O1, t(4))];
    h.rows.ai_memory_blocks = [memoryRow(6, 'org', O1, t(5)), memoryRow(7, 'org', O1, t(5))];
    h.rows.user_notifications = [notifRow(8, null, t(2))];

    const page1 = await listActivity(ceiling(), { limit: 3 });
    // t(5): memory(7) > memory(6) > concern(3) > assessment(1)
    expect(page1.items.map((i) => i.id)).toEqual([uid(7), uid(6), uid(3)]);
    expect(page1.nextCursor).not.toBeNull();

    // A new item lands newer than everything on page 1.
    h.rows.user_notifications = [notifRow(99, null, t(30)), ...h.rows.user_notifications];

    const page2 = await listActivity(ceiling(), { limit: 3, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([uid(1), uid(5), uid(4)]);
    expect(page2.items.map((i) => i.id)).not.toContain(uid(99));

    const page3 = await listActivity(ceiling(), { limit: 3, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.id)).toEqual([uid(8), uid(2)]);
    expect(page3.nextCursor).toBeNull();

    // The keyset is in SQL too, at millisecond precision.
    const q = render(h.wheres.wisp_concerns!.at(-1));
    expect(q.sql).toContain(`date_trunc('milliseconds', "wisp_concerns"."updated_at")`);
  });

  it('nextCursor is the cursor of the last returned item', async () => {
    h.rows.user_notifications = [notifRow(1, null, t(3)), notifRow(2, null, t(2)), notifRow(3, null, t(1))];
    const page = await listActivity(ceiling(), { limit: 2 });
    expect(decodeActivityCursor(page.nextCursor!)).toEqual({ at: t(2), kind: 'nudge', id: uid(2) });
  });
});

describe('currentActivity', () => {
  it('is null when nothing is queued or running', async () => {
    h.rows.ai_agent_runs = [];
    await expect(currentActivity(G1)).resolves.toBeNull();
    const q = render(h.wheres.ai_agent_runs![0]);
    expect(q.params).toEqual(expect.arrayContaining([G1, 'assessment', 'queued', 'running']));
  });

  it('returns the oldest queued/running assessment with its org name', async () => {
    h.rows.ai_agent_runs = [{ orgId: O1, orgName: 'Greenwood', startedAt: null, queuedAt: t(4) }];
    await expect(currentActivity(G1)).resolves.toEqual({ orgId: O1, orgName: 'Greenwood', startedAt: t(4).toISOString() });
    h.rows.ai_agent_runs = [{ orgId: O1, orgName: 'Greenwood', startedAt: t(6), queuedAt: t(4) }];
    await expect(currentActivity(G1)).resolves.toEqual({ orgId: O1, orgName: 'Greenwood', startedAt: t(6).toISOString() });
  });
});
