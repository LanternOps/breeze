/**
 * Wisp companion W02a Task 4 — the thread timeline (messages across the
 * thread's sessions merged with its posts). Drizzle is mocked like
 * activity.test.ts: each `select().from(<table>)` chain resolves to the rows
 * queued for that table and its WHERE is captured for rendering. The SQL
 * ceiling / exclusion / keyset predicates are pinned by rendering; the
 * in-process belts (ceiling, exclusion, keyset re-check) by the items. The
 * real keyset across `timestamp` and `timestamptz` columns is pinned against
 * Postgres in __tests__/integration/wispThreadTimeline.integration.test.ts.
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
  InvalidTimelineCursorError,
  decodeTimelineCursor,
  encodeTimelineCursor,
  listThreadTimeline,
} from './threadTimeline';

const P1 = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const G1 = '99999999-9999-4999-8999-999999999999';
const R1 = '88888888-8888-4888-8888-888888888888';
const T1 = '77777777-7777-4777-8777-777777777777';
const S1 = '55555555-5555-4555-8555-555555555551';
const S2 = '55555555-5555-4555-8555-555555555552';
const M1 = 'a1111111-1111-4111-8111-111111111111';
const M2 = 'a2222222-2222-4222-8222-222222222222';
const PO1 = 'b1111111-1111-4111-8111-111111111111';
const PO2 = 'b2222222-2222-4222-8222-222222222222';
const N1 = 'e1111111-1111-4111-8111-111111111111';

const ceiling = (over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: G1, revisionId: R1, partnerId: P1, grantorUserId: U1, scopeOrgId: null, partnerWide: false,
  orgIds: new Set([O1]), siteIds: null, permissionKeys: new Set(), toolAllowlist: null,
  deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...over,
});

const at = (iso: string) => new Date(iso);
const msg = (id: string, iso: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: S1, sessionOrgId: O1, role: 'assistant', content: `text ${id}`, contentBlocks: null,
  toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt: at(iso), ...over,
});
const post = (id: string, iso: string, over: Record<string, unknown> = {}) => ({
  id, orgId: null, kind: 'brief', title: 'Morning brief', body: 'Two things', link: `/ai/wisp/thread/${T1}`,
  sections: [{ heading: 'Needs you', lines: ['x'] }], concernId: null, notificationId: N1, read: false, createdAt: at(iso), ...over,
});

const dialect = new PgDialect();
const render = (table: string, i = 0) => dialect.sqlToQuery(h.wheres[table]![i] as SQL);

beforeEach(() => {
  h.calls = [];
  h.rows = {};
  h.wheres = {};
});

describe('timeline cursor', () => {
  it('round-trips and rejects anything this module did not encode', () => {
    const c = encodeTimelineCursor({ createdAt: '2026-10-24T09:30:00.123Z', source: 'message', id: M1 });
    expect(decodeTimelineCursor(c)).toEqual({ at: at('2026-10-24T09:30:00.123Z'), source: 'message', id: M1 });
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    for (const bad of [
      'not base64!',
      b64(`2026-10-24T09:30:00.123Z|message`),
      b64(`2026-10-24T09:30:00.123Z|message|${M1}|x`),
      b64(`2026-10-24 09:30|message|${M1}`),
      b64(`2026-10-24T09:30:00.123Z|nudge|${M1}`),
      b64(`2026-10-24T09:30:00.123Z|post|${M1.toUpperCase()}`),
      'A'.repeat(513),
    ]) {
      expect(() => decodeTimelineCursor(bad), bad).toThrow(InvalidTimelineCursorError);
    }
  });
});

describe('listThreadTimeline', () => {
  it('reads both sources in ONE system context and returns the DTOs field by field, newest first', async () => {
    h.rows.ai_messages = [msg(M1, '2026-10-24T09:00:00.000Z', {
      role: 'tool_result', content: null, toolName: 'list_devices', toolInput: { q: 1 }, toolOutput: { tombstone: true }, toolUseId: 'tu1',
      contentBlocks: [{ type: 'text', text: 'x' }],
    })];
    h.rows.wisp_thread_posts = [post(PO1, '2026-10-24T10:00:00.000Z')];
    const page = await listThreadTimeline(ceiling(), T1);
    expect(h.calls).toEqual(['system', 'select:ai_messages', 'select:wisp_thread_posts']);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        source: 'post', id: PO1, kind: 'brief', title: 'Morning brief', body: 'Two things', link: `/ai/wisp/thread/${T1}`,
        sections: [{ heading: 'Needs you', lines: ['x'] }], concernId: null, orgId: null, read: false, createdAt: '2026-10-24T10:00:00.000Z',
      },
      {
        source: 'message', id: M1, sessionId: S1, role: 'tool_result', content: null, contentBlocks: [{ type: 'text', text: 'x' }],
        toolName: 'list_devices', toolInput: { q: 1 }, toolOutput: { tombstone: true }, toolUseId: 'tu1', createdAt: '2026-10-24T09:00:00.000Z',
      },
    ]);
  });

  it('messages: SQL pins the thread, the partner, the ceiling orgs and the visible roles; an out-of-ceiling row is dropped by the belt', async () => {
    h.rows.ai_messages = [msg(M1, '2026-10-24T09:00:00.000Z'), msg(M2, '2026-10-24T09:01:00.000Z', { sessionId: S2, sessionOrgId: O2 })];
    const page = await listThreadTimeline(ceiling(), T1);
    const q = render('ai_messages');
    expect(q.sql).toContain('"wisp_thread_sessions"."thread_id" = $');
    expect(q.sql).toContain('"wisp_thread_sessions"."partner_id" = $');
    expect(q.sql).toMatch(/"wisp_thread_sessions"\."org_id" in \(\$\d+\)/);
    expect(q.sql).toMatch(/"ai_messages"\."role" in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    expect(q.params).toEqual(expect.arrayContaining([T1, P1, O1, 'user', 'assistant', 'tool_use', 'tool_result']));
    expect(q.params).not.toContain(O2);
    expect(page.items.map((i) => i.id)).toEqual([M1]);
  });

  it('excludeSessionId drops that session in SQL and in the belt', async () => {
    h.rows.ai_messages = [msg(M1, '2026-10-24T09:00:00.000Z'), msg(M2, '2026-10-24T09:01:00.000Z', { sessionId: S2 })];
    const page = await listThreadTimeline(ceiling(), T1, { excludeSessionId: S2 });
    const q = render('ai_messages');
    expect(q.sql).toContain('"ai_messages"."session_id" <> $');
    expect(q.params).toContain(S2);
    expect(page.items.map((i) => i.id)).toEqual([M1]);
  });

  it('posts with a null org pass, posts with an out-of-ceiling org do not (SQL and belt)', async () => {
    h.rows.wisp_thread_posts = [
      post(PO1, '2026-10-24T10:00:00.000Z'),
      post(PO2, '2026-10-24T10:01:00.000Z', { orgId: O2, kind: 'nudge' }),
      post(N1, '2026-10-24T10:02:00.000Z', { orgId: O1, kind: 'nudge' }),
    ];
    const page = await listThreadTimeline(ceiling(), T1);
    const q = render('wisp_thread_posts');
    expect(q.sql).toContain('"wisp_thread_posts"."thread_id" = $');
    expect(q.sql).toContain('"wisp_thread_posts"."partner_id" = $');
    expect(q.sql).toContain('"wisp_thread_posts"."grant_id" = $');
    expect(q.sql).toMatch(/\("wisp_thread_posts"\."org_id" is null or "wisp_thread_posts"\."org_id" in \(\$\d+\)\)/);
    expect(q.params).not.toContain(O2);
    expect(page.items.map((i) => i.id)).toEqual([N1, PO1]);
  });

  it('a site-restricted org reads its messages but not its org-level posts (the activity timeline rule)', async () => {
    const restricted = ceiling({ orgTerms: new Map([[O1, { permissionKeys: new Set(), siteIds: new Set(['site-1']) }]]) });
    h.rows.ai_messages = [msg(M1, '2026-10-24T09:00:00.000Z')];
    h.rows.wisp_thread_posts = [post(PO1, '2026-10-24T10:00:00.000Z'), post(PO2, '2026-10-24T10:01:00.000Z', { orgId: O1, kind: 'nudge' })];
    const page = await listThreadTimeline(restricted, T1);
    expect(render('wisp_thread_posts').sql).toContain('"wisp_thread_posts"."org_id" is null');
    expect(render('wisp_thread_posts').sql).not.toContain(' in (');
    expect(page.items.map((i) => i.id)).toEqual([PO1, M1]);
  });

  it('read comes from the linked notification; an unlinked post reports null', async () => {
    h.rows.wisp_thread_posts = [
      post(PO1, '2026-10-24T10:00:00.000Z', { read: true }),
      post(PO2, '2026-10-24T10:01:00.000Z', { notificationId: null, read: null }),
    ];
    const page = await listThreadTimeline(ceiling(), T1);
    expect(page.items.map((i) => (i.source === 'post' ? i.read : 'x'))).toEqual([null, true]);
  });

  it('Review Focus 5: a page boundary between a message and a post in the same millisecond is stable', async () => {
    const same = '2026-10-24T09:30:00.123Z';
    h.rows.ai_messages = [msg(M1, same)];
    h.rows.wisp_thread_posts = [post(PO1, same)];

    // (ms DESC, source DESC, id DESC): 'post' > 'message', so the post comes first.
    const first = await listThreadTimeline(ceiling(), T1, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([PO1]);
    expect(decodeTimelineCursor(first.nextCursor!)).toEqual({ at: at(same), source: 'post', id: PO1 });

    // The mock ignores SQL and hands both rows back: the keyset belt drops the post.
    h.wheres = {};
    const second = await listThreadTimeline(ceiling(), T1, { limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.id)).toEqual([M1]);
    expect(second.nextCursor).toBeNull();

    // SQL: ai_messages.created_at is timestamp WITHOUT time zone holding UTC → the bound is
    // converted AT TIME ZONE 'UTC'; a smaller source than the cursor's is `<=` the bound.
    const m = render('ai_messages');
    expect(m.sql).toContain(`date_trunc('milliseconds', "ai_messages"."created_at") <= ($`);
    expect(m.sql).toMatch(/\$\d+::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(m.params).toContain(same);
    // wisp_thread_posts.created_at is timestamptz: same source as the cursor → id tiebreak, no conversion.
    const p = render('wisp_thread_posts');
    expect(p.sql).toContain(`date_trunc('milliseconds', "wisp_thread_posts"."created_at") < $`);
    expect(p.sql).toContain(`"wisp_thread_posts"."id" < $`);
    expect(p.sql).not.toContain('AT TIME ZONE');
  });

  it('a message cursor puts posts of the same millisecond strictly before the boundary', async () => {
    const same = '2026-10-24T09:30:00.123Z';
    const cursor = encodeTimelineCursor({ createdAt: same, source: 'message', id: M2 });
    h.rows.ai_messages = [msg(M1, same)];
    h.rows.wisp_thread_posts = [post(PO1, same)];
    const page = await listThreadTimeline(ceiling(), T1, { cursor });
    // M1 < M2 → after the cursor; the same-ms post sorts before any message → not after it.
    expect(page.items.map((i) => i.id)).toEqual([M1]);
    expect(render('wisp_thread_posts').sql).toContain(`date_trunc('milliseconds', "wisp_thread_posts"."created_at") < $`);
    expect(render('ai_messages').sql).toContain(`"ai_messages"."id" < $`);
  });

  it('nextCursor is set only when more rows exist, and limits are clamped to 1..100', async () => {
    h.rows.ai_messages = [msg(M1, '2026-10-24T09:00:00.000Z'), msg(M2, '2026-10-24T09:01:00.000Z')];
    const page = await listThreadTimeline(ceiling(), T1, { limit: 1 });
    expect(page.items.map((i) => i.id)).toEqual([M2]);
    expect(page.nextCursor).not.toBeNull();
    const all = await listThreadTimeline(ceiling(), T1, { limit: 0 });
    expect(all.items).toHaveLength(1);
  });

  it('throws InvalidTimelineCursorError on a malformed cursor before any read', async () => {
    await expect(listThreadTimeline(ceiling(), T1, { cursor: 'nope!' })).rejects.toBeInstanceOf(InvalidTimelineCursorError);
    expect(h.calls).toEqual([]);
  });
});
