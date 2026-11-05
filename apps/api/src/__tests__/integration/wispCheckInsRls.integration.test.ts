/**
 * Wisp check-in timers W01 (#10992, feature #10991) — `wisp_check_ins`
 * against real Postgres (migrations/2027-01-20-130000-wisp-check-ins.sql).
 *
 * `rls-coverage.integration.test.ts` proves the table is REGISTERED
 * (DUAL_AXIS_TENANT_TABLES). This file is the functional proof of the
 * partner-anchored / org-optional shape (an org token sees its org's
 * check-ins and never a partner-level one, a sibling partner sees nothing,
 * forges are refused WITH CHECK), of the constraints (composite FKs pin a
 * check-in to one partner; instruction length, due window, status and
 * status-shape CHECKs; the widened thread-post kind CHECK), and of the org
 * registries (cascade delete and merge repoint move only the org rows).
 *
 * Grants and threads are seeded straight into their tables under system scope
 * (createGrant needs a step-up proof, which is not what this file is about).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { wispCheckIns, wispGrantRevisions, wispGrants, wispThreadPosts, wispThreads } from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

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
  if (constraint) expect(pgErrorConstraint(raised), String(raised)).toBe(constraint);
}

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]) {
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: null, grantorUserId, status: 'active',
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
  const uA = await createUser({ partnerId: partnerA.id, email: `wisp-checkin-a-${randomUUID()}@wisp.test` });
  const uB = await createUser({ partnerId: partnerB.id, email: `wisp-checkin-b-${randomUUID()}@wisp.test` });
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

type CheckInInsert = typeof wispCheckIns.$inferInsert;

/** A valid scheduled check-in on partner A's thread, due 10 minutes after its created_at. */
const checkInValues = (f: Fixture, orgId: string | null, extra: Partial<CheckInInsert> = {}): CheckInInsert => {
  const id = randomUUID();
  const createdAt = new Date();
  return {
    id, partnerId: f.partnerA, orgId, grantId: f.grantA, threadId: f.threadA, sessionId: randomUUID(),
    userId: f.userA, createdAt, dueAt: new Date(createdAt.getTime() + 10 * 60_000),
    instruction: 'Verify no msiexec processes remain on the device; if clear, rerun the memory report.',
    context: { subject: { kind: 'device', id: randomUUID() } },
    status: 'scheduled', jobId: `wisp-check-in-${id}`, ...extra,
  };
};

const insertCheckIn = (f: Fixture, orgId: string | null, extra: Partial<CheckInInsert> = {}) =>
  asSystem(async () => {
    const [row] = await db.insert(wispCheckIns).values(checkInValues(f, orgId, extra)).returning();
    return row!;
  });

const visibleIds = async (ctx: DbAccessContext): Promise<string[]> => {
  const rows = await withDbAccessContext(ctx, () => db.select({ id: wispCheckIns.id }).from(wispCheckIns));
  return rows.map((r) => r.id);
};

describe('wisp_check_ins RLS (partner-anchored, org-optional)', () => {
  it('partner A sees its own org and partner-level rows, never partner B\'s', async () => {
    const f = await seed();
    const a1 = await insertCheckIn(f, f.orgA1);
    const a2 = await insertCheckIn(f, f.orgA2);
    const partnerLevel = await insertCheckIn(f, null);
    const b1 = await asSystem(async () => {
      const [row] = await db.insert(wispCheckIns).values(checkInValues(f, f.orgB1, {
        partnerId: f.partnerB, grantId: f.grantB, threadId: f.threadB, userId: f.userB,
      })).returning();
      return row!;
    });

    const ids = await visibleIds(partnerContext(f.partnerA, [f.orgA1, f.orgA2]));
    expect(ids).toEqual(expect.arrayContaining([a1.id, a2.id, partnerLevel.id]));
    expect(ids).not.toContain(b1.id);

    for (const ctx of [partnerContext(f.partnerB, [f.orgB1]), orgContext(f.orgB1, f.partnerB)]) {
      const bIds = await visibleIds(ctx);
      expect(bIds).not.toContain(a1.id);
      expect(bIds).not.toContain(partnerLevel.id);
    }
  });

  it('an org-A1 token sees A1 rows and no partner-level row', async () => {
    const f = await seed();
    const a1 = await insertCheckIn(f, f.orgA1);
    const a2 = await insertCheckIn(f, f.orgA2);
    const partnerLevel = await insertCheckIn(f, null);

    const ids = await visibleIds(orgContext(f.orgA1, f.partnerA));
    expect(ids).toContain(a1.id);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(partnerLevel.id);
  });

  it('a cross-partner insert fails 42501 (and so does an org token writing a partner-level row)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
        db.insert(wispCheckIns).values(checkInValues(f, null))),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
        db.insert(wispCheckIns).values(checkInValues(f, f.orgA1))),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.insert(wispCheckIns).values(checkInValues(f, null))),
      '42501',
    );
  });

  it("a partner-B context cannot update or delete partner A's rows (zero rows)", async () => {
    const f = await seed();
    const a1 = await insertCheckIn(f, f.orgA1);
    const ctx = partnerContext(f.partnerB, [f.orgB1]);
    const updated = await withDbAccessContext(ctx, () =>
      db.update(wispCheckIns).set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(wispCheckIns.id, a1.id)).returning({ id: wispCheckIns.id }));
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(ctx, () =>
      db.delete(wispCheckIns).where(eq(wispCheckIns.id, a1.id)).returning({ id: wispCheckIns.id }));
    expect(deleted).toHaveLength(0);
    const [still] = await asSystem(() => db.select().from(wispCheckIns).where(eq(wispCheckIns.id, a1.id)));
    expect(still!.status).toBe('scheduled');
  });
});

describe('wisp_check_ins constraints', () => {
  it('thread / grant / user / org FKs refuse another partner\'s parent (23503, by constraint name)', async () => {
    const f = await seed();
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { threadId: f.threadB }), '23503', 'wisp_check_ins_thread_fk');
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { grantId: f.grantB }), '23503', 'wisp_check_ins_grant_fk');
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { userId: f.userB }), '23503', 'wisp_check_ins_user_fk');
    await expectSqlState(() => insertCheckIn(f, f.orgB1), '23503', 'wisp_check_ins_org_partner_fk');
  });

  it('instruction of 1001 chars fails wisp_check_ins_instruction_len_chk; 1000 code points and empty are bounded', async () => {
    const f = await seed();
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { instruction: 'x'.repeat(1001) }), '23514', 'wisp_check_ins_instruction_len_chk');
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { instruction: '' }), '23514', 'wisp_check_ins_instruction_len_chk');
    // char_length counts code points: 1000 astral-plane characters (2000 UTF-16 units) fit.
    await insertCheckIn(f, f.orgA1, { instruction: '\u{1F600}'.repeat(1000) });
  });

  it('due_at 30 s after created_at fails wisp_check_ins_due_window_chk', async () => {
    const f = await seed();
    const createdAt = new Date();
    await expectSqlState(
      () => insertCheckIn(f, f.orgA1, { createdAt, dueAt: new Date(createdAt.getTime() + 30_000) }),
      '23514', 'wisp_check_ins_due_window_chk',
    );
    // Exactly 1 minute is allowed.
    await insertCheckIn(f, f.orgA1, { createdAt, dueAt: new Date(createdAt.getTime() + 60_000) });
  });

  it('due_at 7 days + 1 s fails wisp_check_ins_due_window_chk', async () => {
    const f = await seed();
    const createdAt = new Date();
    const sevenDays = 7 * 86_400_000;
    await expectSqlState(
      () => insertCheckIn(f, f.orgA1, { createdAt, dueAt: new Date(createdAt.getTime() + sevenDays + 1000) }),
      '23514', 'wisp_check_ins_due_window_chk',
    );
    // Exactly 7 days is allowed.
    await insertCheckIn(f, f.orgA1, { createdAt, dueAt: new Date(createdAt.getTime() + sevenDays) });
  });

  it("status 'fired' with fired_at NULL fails wisp_check_ins_status_shape_chk (and the other lifecycle shapes)", async () => {
    const f = await seed();
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { status: 'fired', firedAt: null }), '23514', 'wisp_check_ins_status_shape_chk');
    await expectSqlState(
      () => insertCheckIn(f, f.orgA1, { status: 'consumed', firedAt: new Date(), consumedAt: null }),
      '23514', 'wisp_check_ins_status_shape_chk',
    );
    await expectSqlState(
      () => insertCheckIn(f, f.orgA1, { status: 'consumed', firedAt: null, consumedAt: new Date() }),
      '23514', 'wisp_check_ins_status_shape_chk',
    );
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { status: 'cancelled', cancelledAt: null }), '23514', 'wisp_check_ins_status_shape_chk');
    await expectSqlState(() => insertCheckIn(f, f.orgA1, { status: 'snoozed' as never }), '23514', 'wisp_check_ins_status_chk');

    // The legal lifecycle: scheduled -> fired -> consumed.
    const row = await insertCheckIn(f, f.orgA1);
    await asSystem(() => db.update(wispCheckIns).set({ status: 'fired', firedAt: new Date() }).where(eq(wispCheckIns.id, row.id)));
    await asSystem(() => db.update(wispCheckIns).set({ status: 'consumed', consumedAt: new Date() }).where(eq(wispCheckIns.id, row.id)));
    const [done] = await asSystem(() => db.select().from(wispCheckIns).where(eq(wispCheckIns.id, row.id)));
    expect(done!.status).toBe('consumed');
  });

  it("a post of kind check_in inserts; kind 'budget' still fails wisp_thread_posts_kind_chk", async () => {
    const f = await seed();
    const post = (kind: string) => ({
      threadId: f.threadA, partnerId: f.partnerA, grantId: f.grantA, orgId: f.orgA1,
      kind: kind as never, title: 'Check-in due: verify msiexec is gone', body: 'Verify no msiexec processes remain.',
      link: `/ai/wisp/thread/${f.threadA}#checkin=${randomUUID()}`, dedupeKey: `wisp.check_in:${randomUUID()}`,
    });
    const [row] = await asSystem(() => db.insert(wispThreadPosts).values(post('check_in')).returning({ id: wispThreadPosts.id }));
    expect(row!.id).toEqual(expect.any(String));
    await expectSqlState(() => asSystem(() => db.insert(wispThreadPosts).values(post('budget'))), '23514', 'wisp_thread_posts_kind_chk');
  });

  it('deleting the thread cascades its check-ins', async () => {
    const f = await seed();
    await insertCheckIn(f, f.orgA1);
    await insertCheckIn(f, null);
    await asSystem(() => db.delete(wispThreads).where(eq(wispThreads.id, f.threadA)));
    const left = await asSystem(() => db.select().from(wispCheckIns).where(eq(wispCheckIns.threadId, f.threadA)));
    expect(left).toHaveLength(0);
  });
});

describe('wisp_check_ins through the org registries', () => {
  // Behavioural smoke test only: the org FK is ON DELETE CASCADE, so this would
  // pass without the CORE_ORG_CASCADE_DELETE_ORDER entry. That registration is
  // enforced by tenantCascade.integration.test.ts ("every org_id-columned public
  // table is in getOrgCascadeDeleteOrder()").
  it("org erasure deletes the org's check-ins and leaves partner-level ones", async () => {
    const f = await seed();
    const a1 = await insertCheckIn(f, f.orgA1);
    const a2 = await insertCheckIn(f, f.orgA2);
    const partnerLevel = await insertCheckIn(f, null);

    await cascadeDeleteOrg(f.orgA1, f.userA);

    const left = await asSystem(() => db.select({ id: wispCheckIns.id }).from(wispCheckIns)
      .where(inArray(wispCheckIns.id, [a1.id, a2.id, partnerLevel.id])));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([a2.id, partnerLevel.id]));
  }, 120_000);

  it('org merge repoints org_id to the survivor; partner-level rows are untouched', async () => {
    const f = await seed();
    const loser = await insertCheckIn(f, f.orgA1);
    const partnerLevel = await insertCheckIn(f, null);

    await executeOrgMerge({ loserOrgId: f.orgA1, survivorOrgId: f.orgA2, partnerId: f.partnerA, performedBy: f.userA });

    const rows = await asSystem(() => db.select().from(wispCheckIns)
      .where(inArray(wispCheckIns.id, [loser.id, partnerLevel.id])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(loser.id)?.orgId).toBe(f.orgA2);
    expect(byId.get(partnerLevel.id)?.orgId).toBeNull();
  }, 120_000);
});

describe('migration shape', () => {
  const list = <T>(rows: unknown): T[] => (Array.isArray(rows) ? rows : (rows as { rows: T[] }).rows) as T[];

  it('RLS is enabled and forced', async () => {
    const cls = list<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(await asSystem(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'wisp_check_ins' AND relkind = 'r'`)));
    expect(cls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('the org composite FK is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const fks = list<{ conname: string; condeferrable: boolean; condeferred: boolean }>(await asSystem(() => db.execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE conname = 'wisp_check_ins_org_partner_fk'`)));
    expect(fks).toEqual([{ conname: 'wisp_check_ins_org_partner_fk', condeferrable: true, condeferred: false }]);
  });
});
