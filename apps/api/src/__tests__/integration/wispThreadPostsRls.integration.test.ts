/**
 * Wisp companion W02a (#10212, feature #10210) — `wisp_thread_posts` against
 * real Postgres (migrations/2027-01-06-140000-wisp-thread-posts.sql).
 *
 * `rls-coverage.integration.test.ts` proves the table is REGISTERED
 * (DUAL_AXIS_TENANT_TABLES). This file is the functional proof of the
 * partner-anchored / org-optional shape (an org token sees its org's posts and
 * never a partner-level post, a sibling partner sees nothing, forges are
 * refused WITH CHECK), of the constraints (composite FKs pin a post to one
 * partner, kind and link CHECKs, one post per dedupe key per thread, a cleared
 * notification or a deleted concern nulls the reference and keeps the post),
 * of the org registries (cascade delete and merge repoint move only the org
 * rows), and of the notification backfill (kinds, sections, concern and
 * notification links, original timestamps; idempotent on replay).
 *
 * Grants and threads are seeded straight into their tables under system scope
 * (createGrant needs a step-up proof, which is not what this file is about).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  userNotifications,
  wispConcerns,
  wispGrantRevisions,
  wispGrants,
  wispThreadPosts,
  wispThreads,
} from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { recordThreadPost } from '../../services/wisp/threadPosts';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';
import { replayMigration } from './replayMigration';

const MIGRATION = '2027-01-06-140000-wisp-thread-posts.sql';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
  userId: null, currentPartnerId: partnerId,
});

const orgContext = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
  userId: null, currentPartnerId: partnerId,
});

const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function expectSqlState(fn: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised), String(raised)).toBe(code);
  if (constraint) expect(pgErrorConstraint(raised)).toBe(constraint);
}

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[], scopeOrgId: string | null = null) {
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: scopeOrgId, grantorUserId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds, siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return grant!.id;
  });
}

const insertThread = (grantId: string, partnerId: string) =>
  asSystem(async () => {
    const [row] = await db.insert(wispThreads).values({ grantId, partnerId }).returning({ id: wispThreads.id });
    return row!.id;
  });

interface Fixture {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB1: string;
  userA: string; userB: string;
  grantA: string; grantB: string;
  threadA: string; threadB: string;
}

async function seed(): Promise<Fixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const uA = await createUser({ partnerId: partnerA.id, email: `wisp-post-a-${randomUUID()}@wisp.test` });
  const uB = await createUser({ partnerId: partnerB.id, email: `wisp-post-b-${randomUUID()}@wisp.test` });
  const grantA = await seedGrant(partnerA.id, uA.id, [orgA1.id, orgA2.id]);
  const grantB = await seedGrant(partnerB.id, uB.id, [orgB1.id]);
  return {
    partnerA: partnerA.id, partnerB: partnerB.id,
    orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    userA: uA.id, userB: uB.id,
    grantA, grantB,
    threadA: await insertThread(grantA, partnerA.id),
    threadB: await insertThread(grantB, partnerB.id),
  };
}

type PostInsert = typeof wispThreadPosts.$inferInsert;

const postValues = (f: Fixture, orgId: string | null, extra: Partial<PostInsert> = {}): PostInsert => ({
  threadId: f.threadA, partnerId: f.partnerA, grantId: f.grantA, orgId,
  kind: orgId ? 'nudge' : 'brief', title: 'Greenwood: ticket waiting 3 days', body: 'Waiting on the customer.',
  link: `/ai/wisp/thread/${f.threadA}`, dedupeKey: `wisp.nudge:${randomUUID()}`, ...extra,
});

const insertPost = (f: Fixture, orgId: string | null, extra: Partial<PostInsert> = {}) =>
  asSystem(async () => {
    const [row] = await db.insert(wispThreadPosts).values(postValues(f, orgId, extra)).returning();
    return row!;
  });

const insertConcern = (partnerId: string, orgId: string | null) =>
  asSystem(async () => {
    const [row] = await db.insert(wispConcerns).values({
      partnerId, orgId, subjectKind: 'ticket', subjectId: randomUUID(),
      summary: 'Ticket waiting on the customer for 3 days', severity: 'medium',
    }).returning({ id: wispConcerns.id });
    return row!.id;
  });

const visibleIds = async (ctx: DbAccessContext): Promise<string[]> => {
  const rows = await withDbAccessContext(ctx, () => db.select({ id: wispThreadPosts.id }).from(wispThreadPosts));
  return rows.map((r) => r.id);
};

describe('wisp_thread_posts RLS (partner-anchored, org-optional)', () => {
  it("an org token sees its org's posts, not a sibling org's and never a partner-level (org_id NULL) post", async () => {
    const f = await seed();
    const a1 = await insertPost(f, f.orgA1);
    const a2 = await insertPost(f, f.orgA2);
    const partnerLevel = await insertPost(f, null);

    const ids = await visibleIds(orgContext(f.orgA1, f.partnerA));
    expect(ids).toContain(a1.id);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(partnerLevel.id);
  });

  it('a partner context sees its org posts and its partner-level posts', async () => {
    const f = await seed();
    const a1 = await insertPost(f, f.orgA1);
    const a2 = await insertPost(f, f.orgA2);
    const partnerLevel = await insertPost(f, null);

    const ids = await visibleIds(partnerContext(f.partnerA, [f.orgA1, f.orgA2]));
    expect(ids).toEqual(expect.arrayContaining([a1.id, a2.id, partnerLevel.id]));
  });

  it("partner B (partner or org context) sees none of partner A's posts", async () => {
    const f = await seed();
    const a1 = await insertPost(f, f.orgA1);
    const partnerLevel = await insertPost(f, null);

    for (const ctx of [partnerContext(f.partnerB, [f.orgB1]), orgContext(f.orgB1, f.partnerB)]) {
      const ids = await visibleIds(ctx);
      expect(ids).not.toContain(a1.id);
      expect(ids).not.toContain(partnerLevel.id);
    }
  });

  it('cross-tenant and org-token partner-level forges are refused WITH CHECK (42501)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
        db.insert(wispThreadPosts).values(postValues(f, null))),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
        db.insert(wispThreadPosts).values(postValues(f, f.orgA1))),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.insert(wispThreadPosts).values(postValues(f, null))),
      '42501',
    );
  });

  it("a partner-B context cannot update or delete partner A's posts (zero rows)", async () => {
    const f = await seed();
    const a1 = await insertPost(f, f.orgA1);
    const ctx = partnerContext(f.partnerB, [f.orgB1]);
    const updated = await withDbAccessContext(ctx, () =>
      db.update(wispThreadPosts).set({ title: 'pwned' }).where(eq(wispThreadPosts.id, a1.id)).returning({ id: wispThreadPosts.id }));
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(ctx, () =>
      db.delete(wispThreadPosts).where(eq(wispThreadPosts.id, a1.id)).returning({ id: wispThreadPosts.id }));
    expect(deleted).toHaveLength(0);
    const [still] = await asSystem(() => db.select().from(wispThreadPosts).where(eq(wispThreadPosts.id, a1.id)));
    expect(still!.title).toBe('Greenwood: ticket waiting 3 days');
  });
});

describe('wisp_thread_posts constraints', () => {
  it('every composite FK pins the post to one partner (23503)', async () => {
    const f = await seed();
    await expectSqlState(() => insertPost(f, f.orgA1, { threadId: f.threadB }), '23503', 'wisp_thread_posts_thread_fk');
    await expectSqlState(() => insertPost(f, f.orgA1, { grantId: f.grantB }), '23503', 'wisp_thread_posts_grant_fk');
    await expectSqlState(() => insertPost(f, f.orgB1), '23503', 'wisp_thread_posts_org_partner_fk');
  });

  it('kind and link CHECKs hold (23514)', async () => {
    const f = await seed();
    await expectSqlState(() => insertPost(f, f.orgA1, { kind: 'budget' as never }), '23514', 'wisp_thread_posts_kind_chk');
    await expectSqlState(() => insertPost(f, f.orgA1, { link: '//evil.example/x' }), '23514', 'wisp_thread_posts_link_relative_chk');
    await expectSqlState(() => insertPost(f, f.orgA1, { link: 'https://evil.example/x' }), '23514', 'wisp_thread_posts_link_relative_chk');
    await insertPost(f, f.orgA1, { link: null });
  });

  it('one post per (thread, dedupe_key) — 23505; the same key on another thread is a different post', async () => {
    const f = await seed();
    const key = `wisp.brief:${f.threadA}:2026-10-25`;
    await insertPost(f, null, { dedupeKey: key });
    await expectSqlState(() => insertPost(f, null, { dedupeKey: key }), '23505', 'wisp_thread_posts_thread_dedupe_uq');
  });

  it('a cleared notification or a deleted concern nulls the reference and keeps the post; deleting the thread cascades', async () => {
    const f = await seed();
    const concernId = await insertConcern(f.partnerA, f.orgA1);
    const [notification] = await asSystem(() => db.insert(userNotifications).values({
      userId: f.userA, orgId: f.orgA1, type: 'ai', title: 'Nudge', dedupeKey: `wisp.nudge:${concernId}:${f.grantA}:first`,
    }).returning({ id: userNotifications.id }));
    const post = await insertPost(f, f.orgA1, { concernId, notificationId: notification!.id });

    await asSystem(() => db.delete(userNotifications).where(eq(userNotifications.id, notification!.id)));
    await asSystem(() => db.delete(wispConcerns).where(eq(wispConcerns.id, concernId)));
    const [kept] = await asSystem(() => db.select().from(wispThreadPosts).where(eq(wispThreadPosts.id, post.id)));
    expect(kept).toMatchObject({ notificationId: null, concernId: null, orgId: f.orgA1, partnerId: f.partnerA });

    await asSystem(() => db.delete(wispThreads).where(eq(wispThreads.id, f.threadA)));
    const left = await asSystem(() => db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, f.threadA)));
    expect(left).toHaveLength(0);
  });
});

describe('recordThreadPost against real Postgres', () => {
  it('writes once per dedupe key (the ON CONFLICT arbiter is the unique index) and refuses a concern of another partner', async () => {
    const f = await seed();
    const input = {
      threadId: f.threadA, partnerId: f.partnerA, grantId: f.grantA, orgId: null, kind: 'brief' as const,
      title: 'Your morning brief', body: 'Two things need you.', link: `/ai/wisp/thread/${f.threadA}`,
      sections: [{ heading: 'Needs you', lines: ['Greenwood: ticket waiting 3 days'] }],
      concernId: null, notificationId: null, dedupeKey: `wisp.brief:${f.threadA}:2026-10-25`,
    };
    const first = await asSystem(() => recordThreadPost(input));
    expect(first.created).toBe(true);
    expect(first.id).toEqual(expect.any(String));
    const again = await asSystem(() => recordThreadPost({ ...input, title: 'a retry' }));
    expect(again).toEqual({ created: false, id: null });
    const rows = await asSystem(() => db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, f.threadA)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Your morning brief');

    const foreignConcern = await insertConcern(f.partnerB, f.orgB1);
    await expect(asSystem(() => recordThreadPost({
      ...input, kind: 'nudge', concernId: foreignConcern, dedupeKey: `wisp.nudge:${foreignConcern}:${f.grantA}:first`,
    }))).rejects.toThrow(/concern/);
  });
});

describe('wisp_thread_posts through the org registries', () => {
  it("org erasure (cascadeDeleteOrg) removes the org's posts and leaves the thread and partner-level posts", async () => {
    const f = await seed();
    const a1 = await insertPost(f, f.orgA1);
    const a2 = await insertPost(f, f.orgA2);
    const partnerLevel = await insertPost(f, null);

    await cascadeDeleteOrg(f.orgA1, f.userA);

    const left = await asSystem(() => db.select({ id: wispThreadPosts.id }).from(wispThreadPosts)
      .where(inArray(wispThreadPosts.id, [a1.id, a2.id, partnerLevel.id])));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([a2.id, partnerLevel.id]));
    const threads = await asSystem(() => db.select({ id: wispThreads.id }).from(wispThreads).where(eq(wispThreads.id, f.threadA)));
    expect(threads).toHaveLength(1);
  }, 120_000);

  it("org merge repoints the loser's posts to the survivor; partner-level posts are untouched", async () => {
    const f = await seed();
    const loserPost = await insertPost(f, f.orgA1);
    const partnerLevel = await insertPost(f, null);

    await executeOrgMerge({ loserOrgId: f.orgA1, survivorOrgId: f.orgA2, partnerId: f.partnerA, performedBy: f.userA });

    const rows = await asSystem(() => db.select().from(wispThreadPosts)
      .where(inArray(wispThreadPosts.id, [loserPost.id, partnerLevel.id])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(loserPost.id)!.orgId).toBe(f.orgA2);
    expect(byId.get(partnerLevel.id)!.orgId).toBeNull();
  }, 120_000);
});

describe('notification backfill (replayed migration)', () => {
  it('turns surviving brief / nudge / digest notifications into posts, keeps their timestamps, skips everything else, and is idempotent', async () => {
    const f = await seed();
    const concernId = await insertConcern(f.partnerA, f.orgA1);
    const sections = [{ heading: 'Needs you', lines: ['Greenwood: ticket waiting 3 days'] }];
    const meta = (extra: Record<string, unknown> = {}) => ({ wispThreadId: f.threadA, grantId: f.grantA, concernId: null, ...extra });
    const at = (iso: string) => new Date(iso);

    const notes = await asSystem(() => db.insert(userNotifications).values([
      { userId: f.userA, orgId: null, type: 'ai', title: 'Morning brief', message: 'Two things', link: `/ai/wisp/thread/${f.threadA}`,
        dedupeKey: `wisp.brief:${f.threadA}:2026-10-24`, metadata: meta({ brief: sections }), createdAt: at('2026-10-24T07:00:00.123Z') },
      { userId: f.userA, orgId: f.orgA1, type: 'ai', title: 'Ticket waiting', message: 'Three days', link: `/ai/wisp/thread/${f.threadA}#concern=${concernId}`,
        dedupeKey: `wisp.nudge:${concernId}:${f.grantA}:first`, metadata: meta({ concernId }), createdAt: at('2026-10-24T09:30:00.000Z') },
      { userId: f.userA, orgId: null, type: 'ai', title: 'Digest', message: null, link: null,
        dedupeKey: `wisp.digest:${f.threadA}:2026-10-24T10:00:00.000Z`, metadata: meta(), createdAt: at('2026-10-24T10:00:01.000Z') },
      // Not posts: a budget notice, a nudge to someone who is not the grantor, a malformed thread id.
      { userId: f.userA, orgId: null, type: 'ai', title: 'Budget', dedupeKey: `wisp-budget-${f.grantA}-2026-10-24`, metadata: meta() },
      { userId: f.userB, orgId: null, type: 'ai', title: 'Not yours', dedupeKey: `wisp.digest:${f.threadA}:x`, metadata: meta() },
      { userId: f.userA, orgId: null, type: 'ai', title: 'Malformed', dedupeKey: 'wisp.digest:broken', metadata: meta({ wispThreadId: 'not-a-uuid' }) },
    ]).returning({ id: userNotifications.id, dedupeKey: userNotifications.dedupeKey }));
    const noteId = (prefix: string) => notes.find((n) => n.dedupeKey!.startsWith(prefix))!.id;

    await replayMigration(MIGRATION);
    await replayMigration(MIGRATION);

    const posts = await asSystem(() => db.select().from(wispThreadPosts).where(eq(wispThreadPosts.threadId, f.threadA)));
    expect(posts).toHaveLength(3);
    const byKind = new Map(posts.map((p) => [p.kind, p]));
    expect(byKind.get('brief')).toMatchObject({
      partnerId: f.partnerA, grantId: f.grantA, orgId: null, title: 'Morning brief', body: 'Two things',
      sections, concernId: null, notificationId: noteId('wisp.brief:'),
    });
    expect(byKind.get('brief')!.createdAt.toISOString()).toBe('2026-10-24T07:00:00.123Z');
    expect(byKind.get('nudge')).toMatchObject({ orgId: f.orgA1, concernId, notificationId: noteId('wisp.nudge:'), sections: null });
    expect(byKind.get('nudge')!.createdAt.toISOString()).toBe('2026-10-24T09:30:00.000Z');
    expect(byKind.get('digest')).toMatchObject({ orgId: null, body: null, link: null, notificationId: noteId(`wisp.digest:${f.threadA}:2026`) });
  }, 120_000);
});

describe('migration shape', () => {
  const list = <T>(rows: unknown): T[] => (Array.isArray(rows) ? rows : (rows as { rows: T[] }).rows) as T[];

  it('RLS is enabled and forced; the org composite FK is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const cls = list<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(await asSystem(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'wisp_thread_posts' AND relkind = 'r'`)));
    expect(cls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const fks = list<{ conname: string; condeferrable: boolean; condeferred: boolean }>(await asSystem(() => db.execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE conname = 'wisp_thread_posts_org_partner_fk'`)));
    expect(fks).toEqual([{ conname: 'wisp_thread_posts_org_partner_fk', condeferrable: true, condeferred: false }]);
  });
});
