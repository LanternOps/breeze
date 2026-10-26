/**
 * Wisp companion W02a (#10212) — `listThreadTimeline` against real Postgres.
 *
 * The unit test pins the SQL by rendering; this one runs it. Review Focus 5:
 * `ai_messages.created_at` is `timestamp without time zone` (UTC) while
 * `wisp_thread_posts.created_at` is `timestamptz`, so a cursor built from a
 * message must bound posts and messages alike. Paging a thread one item at a
 * time must visit every visible row exactly once, in (ms DESC, source DESC,
 * id DESC) order, including a message and a post in the same millisecond.
 * The SQL ceiling and session exclusion are exercised here too (the in-process
 * belts are pinned by the unit test).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiMessages,
  aiSessions,
  userNotifications,
  wispGrants,
  wispThreadPosts,
  wispThreadSessions,
  wispThreads,
} from '../../db/schema';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import { listThreadTimeline } from '../../services/wisp/threadTimeline';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-timeline-${randomUUID()}@wisp.test` });
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: user.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [thread] = await db.insert(wispThreads).values({ grantId: grant!.id, partnerId: partner.id }).returning({ id: wispThreads.id });
    const session = async (orgId: string) => {
      const [s] = await db.insert(aiSessions).values({ orgId, userId: user.id, model: 'claude-sonnet-5-5' }).returning({ id: aiSessions.id });
      await db.insert(wispThreadSessions).values({ threadId: thread!.id, sessionId: s!.id, partnerId: partner.id, orgId });
      return s!.id;
    };
    const s1 = await session(orgA.id);
    const s2 = await session(orgA.id);
    const sOut = await session(orgB.id); // an org outside the ceiling below
    return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, grantId: grant!.id, threadId: thread!.id, s1, s2, sOut };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const ceilingOf = (f: Seeded, orgIds: string[]): GrantCeiling => ({
  grantId: f.grantId, revisionId: randomUUID(), partnerId: f.partnerId, grantorUserId: f.userId,
  scopeOrgId: null, partnerWide: false, orgIds: new Set(orgIds), siteIds: null, permissionKeys: new Set(),
  toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(), status: 'paused',
});

const message = (sessionId: string, iso: string, role: 'user' | 'assistant' | 'system' = 'assistant') =>
  asSystem(async () => {
    const [m] = await db.insert(aiMessages).values({ sessionId, role, content: `${role} @ ${iso}`, createdAt: new Date(iso) })
      .returning({ id: aiMessages.id });
    return m!.id;
  });

const post = (f: Seeded, iso: string, extra: Partial<typeof wispThreadPosts.$inferInsert> = {}) =>
  asSystem(async () => {
    const [p] = await db.insert(wispThreadPosts).values({
      threadId: f.threadId, partnerId: f.partnerId, grantId: f.grantId, orgId: null, kind: 'brief',
      title: `post @ ${iso}`, dedupeKey: `wisp.brief:${randomUUID()}`, createdAt: new Date(iso), ...extra,
    }).returning({ id: wispThreadPosts.id });
    return p!.id;
  });

/**
 * With `timeZone`, each page runs inside an ambient system transaction whose
 * session TimeZone is not UTC (listThreadTimeline's inSystemContext reuses an
 * ambient system context). A `timestamp without time zone` column compared to
 * a timestamptz bound is then cast through that zone: only the explicit
 * `AT TIME ZONE 'UTC'` bound keeps the message keyset right.
 */
async function pageAll(ceiling: GrantCeiling, threadId: string, opts: { excludeSessionId?: string; timeZone?: string } = {}) {
  const { timeZone, ...rest } = opts;
  const read = (cursor: string | undefined) => {
    const call = () => listThreadTimeline(ceiling, threadId, { limit: 1, cursor, ...rest });
    if (!timeZone) return call();
    return asSystem(async () => {
      await db.execute(sql`SELECT set_config('TimeZone', ${timeZone}, true)`);
      return call();
    });
  };
  const seen: Array<{ id: string; source: string; createdAt: string }> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await read(cursor);
    seen.push(...page.items.map((it) => ({ id: it.id, source: it.source, createdAt: it.createdAt })));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('listThreadTimeline (real Postgres)', () => {
  it('Review Focus 5: one-at-a-time paging visits every row once, across timestamp and timestamptz in the same millisecond', async () => {
    const f = await seed();
    const same = '2026-10-24T09:30:00.123Z';
    const m1 = await message(f.s1, '2026-10-24T09:00:00.000Z');
    const m2 = await message(f.s1, same);
    const m3 = await message(f.s2, same);
    const pSame = await post(f, same);
    const pLater = await post(f, '2026-10-24T10:00:00.000Z', { kind: 'digest', dedupeKey: `wisp.digest:${randomUUID()}` });
    await message(f.s1, '2026-10-24T09:45:00.000Z', 'system'); // never shown
    await message(f.sOut, '2026-10-24T09:50:00.000Z'); // outside the ceiling

    const sameMs = [m2, m3].sort().reverse(); // id DESC within (ms, 'message')
    for (const timeZone of [undefined, 'America/New_York', 'Asia/Kolkata']) {
      const seen = await pageAll(ceilingOf(f, [f.orgA]), f.threadId, { timeZone });
      expect(seen.map((s) => s.id), `TimeZone ${timeZone ?? 'default'}`).toEqual([pLater, pSame, ...sameMs, m1]);
      expect(new Set(seen.map((s) => s.id)).size).toBe(seen.length);
      expect(seen.find((s) => s.id === m2)!.createdAt).toBe(same);
      expect(seen.find((s) => s.id === pSame)!.createdAt).toBe(same);
    }
  }, 120_000);

  it('excludeSessionId leaves that session out; a bigger page agrees with one-at-a-time paging', async () => {
    const f = await seed();
    const a = await message(f.s1, '2026-10-24T09:00:00.000Z');
    await message(f.s2, '2026-10-24T09:01:00.000Z');
    const b = await message(f.s1, '2026-10-24T09:02:00.000Z');
    const p = await post(f, '2026-10-24T09:01:30.000Z');

    const ceiling = ceilingOf(f, [f.orgA]);
    const one = await pageAll(ceiling, f.threadId, { excludeSessionId: f.s2 });
    const big = await listThreadTimeline(ceiling, f.threadId, { limit: 50, excludeSessionId: f.s2 });
    expect(one.map((s) => s.id)).toEqual([b, p, a]);
    expect(big.items.map((i) => i.id)).toEqual([b, p, a]);
    expect(big.nextCursor).toBeNull();
  }, 120_000);

  it('posts: org NULL and in-ceiling orgs pass, out-of-ceiling orgs do not; read follows the linked notification', async () => {
    const f = await seed();
    const [note] = await asSystem(() => db.insert(userNotifications).values({
      userId: f.userId, orgId: f.orgA, type: 'ai', title: 'Nudge', dedupeKey: `wisp.nudge:${randomUUID()}`, read: true,
    }).returning({ id: userNotifications.id }));
    const inOrg = await post(f, '2026-10-24T09:00:00.000Z', { orgId: f.orgA, kind: 'nudge', notificationId: note!.id });
    const outOrg = await post(f, '2026-10-24T09:01:00.000Z', { orgId: f.orgB, kind: 'nudge' });
    const partnerLevel = await post(f, '2026-10-24T09:02:00.000Z');

    const page = await listThreadTimeline(ceilingOf(f, [f.orgA]), f.threadId, { limit: 50 });
    expect(page.items.map((i) => i.id)).toEqual([partnerLevel, inOrg]);
    expect(page.items.map((i) => i.id)).not.toContain(outOrg);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(inOrg)).toMatchObject({ source: 'post', read: true });
    expect(byId.get(partnerLevel)).toMatchObject({ source: 'post', read: null });

    await asSystem(() => db.delete(userNotifications).where(eq(userNotifications.id, note!.id)));
    const after = await listThreadTimeline(ceilingOf(f, [f.orgA]), f.threadId, { limit: 50 });
    expect(after.items.find((i) => i.id === inOrg)).toMatchObject({ read: null });
  }, 120_000);
});
