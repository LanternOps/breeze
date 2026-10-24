/**
 * Wisp W04 (#9910) — `wisp_threads`, `wisp_thread_sessions`,
 * `wisp_thread_attachments` and the `ai_sessions` grant columns against real
 * Postgres (migrations/2027-01-04-110200-wisp-threads.sql).
 *
 * `rls-coverage.integration.test.ts` proves the tables are REGISTERED. This
 * file is the functional proof: it forges cross-partner / cross-org reads and
 * writes and watches Postgres refuse them, and drives every composite FK and
 * CHECK the migration declares (one thread per grant, the summary cap, the
 * focus-org column-list SET NULL, the attachment ↔ artifact org binding, the
 * session-column pair).
 *
 * Grants are seeded straight into `wisp_grants` + `wisp_grant_revisions`
 * under system scope: `createGrant` needs a step-up proof, which is not what
 * this file is about.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiMessages,
  aiRunArtifacts,
  aiSessions,
  organizations,
  wispGrantRevisions,
  wispGrants,
  wispThreadAttachments,
  wispThreads,
  wispThreadSessions,
} from '../../db/schema';
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
  if (constraint) expect(pgErrorConstraint(raised)).toBe(constraint);
}

interface Fixture {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB1: string;
  grantA: { grantId: string; revisionId: string };
  grantB: { grantId: string; revisionId: string };
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
    return { grantId: grant!.id, revisionId: revision!.id };
  });
}

async function seed(): Promise<Fixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const uA = await createUser({ partnerId: partnerA.id, email: `wisp-thread-a-${randomUUID()}@wisp.test` });
  const uB = await createUser({ partnerId: partnerB.id, email: `wisp-thread-b-${randomUUID()}@wisp.test` });
  return {
    partnerA: partnerA.id, partnerB: partnerB.id,
    orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    grantA: await seedGrant(partnerA.id, uA.id, [orgA1.id, orgA2.id]),
    grantB: await seedGrant(partnerB.id, uB.id, [orgB1.id]),
  };
}

const insertThread = (grantId: string, partnerId: string, extra: Partial<typeof wispThreads.$inferInsert> = {}) =>
  asSystem(async () => {
    const [row] = await db.insert(wispThreads).values({ grantId, partnerId, ...extra }).returning();
    return row!;
  });

const insertSession = (orgId: string) =>
  asSystem(async () => {
    const [row] = await db.insert(aiSessions).values({ orgId, model: 'claude-sonnet-5-5' }).returning({ id: aiSessions.id });
    return row!.id;
  });

const insertArtifact = (orgId: string) =>
  asSystem(async () => {
    const [row] = await db.insert(aiRunArtifacts).values({
      orgId,
      runId: null,
      kind: 'input_capture',
      name: 'notes.redacted.txt',
      contentType: 'text/plain',
      bytes: 42,
      sha256: 'a'.repeat(64),
      blobKey: `us/2027/01/${randomUUID()}`,
      createdByTool: 'wisp_thread_attachment',
    }).returning({ id: aiRunArtifacts.id });
    return row!.id;
  });

describe('wisp_threads / wisp_thread_sessions RLS (shape 3)', () => {
  it("a partner context reads its own thread and not a sibling partner's", async () => {
    const f = await seed();
    const threadA = await insertThread(f.grantA.grantId, f.partnerA);
    const threadB = await insertThread(f.grantB.grantId, f.partnerB);
    const sessionA = await insertSession(f.orgA1);
    const sessionB = await insertSession(f.orgB1);
    await asSystem(() => db.insert(wispThreadSessions).values([
      { threadId: threadA.id, sessionId: sessionA, partnerId: f.partnerA, orgId: f.orgA1 },
      { threadId: threadB.id, sessionId: sessionB, partnerId: f.partnerB, orgId: f.orgB1 },
    ]));

    const ids = [threadA.id, threadB.id];
    await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), async () => {
      const threads = await db.select({ id: wispThreads.id }).from(wispThreads).where(inArray(wispThreads.id, ids));
      expect(threads.map((r) => r.id)).toEqual([threadA.id]);
      const links = await db.select({ threadId: wispThreadSessions.threadId }).from(wispThreadSessions)
        .where(inArray(wispThreadSessions.threadId, ids));
      expect(links.map((r) => r.threadId)).toEqual([threadA.id]);
    });
    await withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), async () => {
      const threads = await db.select({ id: wispThreads.id }).from(wispThreads).where(eq(wispThreads.id, threadA.id));
      expect(threads).toHaveLength(0);
      // UPDATE / DELETE of the sibling partner's rows match nothing.
      const updated = await db.update(wispThreads).set({ summary: 'forged' }).where(eq(wispThreads.id, threadA.id)).returning();
      expect(updated).toHaveLength(0);
      const deleted = await db.delete(wispThreadSessions).where(eq(wispThreadSessions.threadId, threadA.id)).returning();
      expect(deleted).toHaveLength(0);
    });
  });

  it('cross-partner insert into wisp_threads is refused with 42501', async () => {
    const f = await seed();
    // A failed statement aborts the context's transaction, so the whole
    // context call is what rejects.
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
        db.insert(wispThreads).values({ grantId: f.grantA.grantId, partnerId: f.partnerA })),
      '42501',
    );
    // Own partner works (the policy admits partner reach, not only system).
    await withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), async () => {
      const [row] = await db.insert(wispThreads).values({ grantId: f.grantB.grantId, partnerId: f.partnerB }).returning();
      expect(row!.partnerId).toBe(f.partnerB);
    });
  });

  it('wisp_threads_grant_uq: second thread for the same grant is refused with 23505', async () => {
    const f = await seed();
    await insertThread(f.grantA.grantId, f.partnerA);
    await expectSqlState(() => insertThread(f.grantA.grantId, f.partnerA), '23505', 'wisp_threads_grant_uq');
  });

  it('a thread cannot name a grant from another partner (23503 on the composite grant FK)', async () => {
    const f = await seed();
    await expectSqlState(() => insertThread(f.grantB.grantId, f.partnerA), '23503', 'wisp_threads_grant_fk');
  });

  it('summary longer than 4000 chars is refused with 23514', async () => {
    const f = await seed();
    await expectSqlState(
      () => insertThread(f.grantA.grantId, f.partnerA, { summary: 'x'.repeat(4001) }),
      '23514',
      'wisp_threads_summary_len_chk',
    );
    const ok = await insertThread(f.grantA.grantId, f.partnerA, { summary: 'x'.repeat(4000) });
    expect(ok.summary).toHaveLength(4000);
  });

  it('wisp_thread_sessions: a session from an org outside the partner is refused (23503 on org_fk)', async () => {
    const f = await seed();
    const threadA = await insertThread(f.grantA.grantId, f.partnerA);
    const sessionB = await insertSession(f.orgB1);
    await expectSqlState(
      () => asSystem(() => db.insert(wispThreadSessions).values({
        threadId: threadA.id, sessionId: sessionB, partnerId: f.partnerA, orgId: f.orgB1,
      })),
      '23503',
      'wisp_thread_sessions_org_fk',
    );
    // org_id must be the session's own org (composite session FK).
    await expectSqlState(
      () => asSystem(() => db.insert(wispThreadSessions).values({
        threadId: threadA.id, sessionId: sessionB, partnerId: f.partnerA, orgId: f.orgA1,
      })),
      '23503',
      'wisp_thread_sessions_session_fk',
    );
  });

  it('deleting the ai_sessions row cascades the wisp_thread_sessions row', async () => {
    const f = await seed();
    const threadA = await insertThread(f.grantA.grantId, f.partnerA);
    const sessionA = await insertSession(f.orgA1);
    await asSystem(() => db.insert(wispThreadSessions).values({
      threadId: threadA.id, sessionId: sessionA, partnerId: f.partnerA, orgId: f.orgA1,
    }));
    await asSystem(async () => {
      await db.delete(aiSessions).where(eq(aiSessions.id, sessionA));
      expect(await db.select().from(wispThreadSessions).where(eq(wispThreadSessions.sessionId, sessionA))).toEqual([]);
      expect(await db.select().from(wispThreads).where(eq(wispThreads.id, threadA.id))).toHaveLength(1);
    });
  });

  it('ai_sessions_wisp_grant_pair_chk refuses a grant id without a revision id (23514); deleting the grant clears both', async () => {
    const f = await seed();
    await expectSqlState(
      () => asSystem(() => db.insert(aiSessions).values({
        orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: f.grantA.grantId,
      })),
      '23514',
      'ai_sessions_wisp_grant_pair_chk',
    );
    // The revision must belong to the named grant (composite FK).
    await expectSqlState(
      () => asSystem(() => db.insert(aiSessions).values({
        orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: f.grantA.grantId, wispGrantRevisionId: f.grantB.revisionId,
      })),
      '23503',
      'ai_sessions_wisp_grant_revision_fk',
    );

    const [session] = await asSystem(() => db.insert(aiSessions).values({
      orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: f.grantA.grantId, wispGrantRevisionId: f.grantA.revisionId,
    }).returning({ id: aiSessions.id }));
    const thread = await insertThread(f.grantA.grantId, f.partnerA);

    // Erasure-shaped grant delete (system scope): the revision cascade nulls
    // BOTH session columns in one action, so the pair CHECK holds, and the
    // thread goes with its grant.
    await asSystem(async () => {
      await db.delete(wispGrants).where(eq(wispGrants.id, f.grantA.grantId));
      const [after] = await db.select({ g: aiSessions.wispGrantId, r: aiSessions.wispGrantRevisionId })
        .from(aiSessions).where(eq(aiSessions.id, session!.id));
      expect(after).toEqual({ g: null, r: null });
      expect(await db.select().from(wispThreads).where(eq(wispThreads.id, thread.id))).toEqual([]);
    });
  });

  it("ai_sessions_wisp_grant_tenant_guard: a session cannot pin another partner's grant or a grant scoped to another org, and the pin is immutable (23503 / 42501)", async () => {
    const f = await seed();
    // Partner B's grant on a partner-A session.
    await expectSqlState(
      () => asSystem(() => db.insert(aiSessions).values({
        orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: f.grantB.grantId, wispGrantRevisionId: f.grantB.revisionId,
      })),
      '23503',
    );
    // An org-scoped grant (org A1) on a session in org A2 of the same partner.
    const grantor = await asSystem(async () => (await db.select({ u: wispGrants.grantorUserId }).from(wispGrants)
      .where(eq(wispGrants.id, f.grantA.grantId)))[0]!.u);
    const scoped = await seedGrant(f.partnerA, grantor, [f.orgA1], f.orgA1);
    await expectSqlState(
      () => asSystem(() => db.insert(aiSessions).values({
        orgId: f.orgA2, model: 'claude-sonnet-5-5', wispGrantId: scoped.grantId, wispGrantRevisionId: scoped.revisionId,
      })),
      '23503',
    );
    // In scope: accepted. Re-pointing the pin afterwards is refused.
    const [ok] = await asSystem(() => db.insert(aiSessions).values({
      orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: scoped.grantId, wispGrantRevisionId: scoped.revisionId,
    }).returning({ id: aiSessions.id }));
    await expectSqlState(
      () => asSystem(() => db.update(aiSessions).set({ wispGrantId: null, wispGrantRevisionId: null }).where(eq(aiSessions.id, ok!.id))),
      '42501',
    );
  });

  it('ai_sessions_wisp_grant_tenant_guard from an ORG-scoped request context: it sees the partner-axis grant the context cannot (SECURITY DEFINER) and still refuses out-of-scope pins (23503)', async () => {
    const f = await seed();
    const tenantGuardRefusal = async (orgId: string, partnerId: string, sessionOrgId: string, grant: { grantId: string; revisionId: string }) => {
      let raised: unknown;
      try {
        await withDbAccessContext(orgContext(orgId, partnerId), () => db.insert(aiSessions).values({
          orgId: sessionOrgId, model: 'claude-sonnet-5-5', wispGrantId: grant.grantId, wispGrantRevisionId: grant.revisionId,
        }));
      } catch (err) { raised = err; }
      expect(raised, 'expected the tenant guard to refuse the pin').toBeDefined();
      expect(pgErrorCode(raised), String(raised)).toBe('23503');
      // The guard's own refusal, not an FK on the pair.
      expect(String((raised as { cause?: { message?: string } }).cause?.message ?? raised)).toContain('is not in the tenant scope of org');
    };

    // The precondition the SECURITY DEFINER exists for: an org-scoped context
    // cannot read its partner's grant row at all.
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(await db.select({ id: wispGrants.id }).from(wispGrants).where(eq(wispGrants.id, f.grantA.grantId))).toEqual([]);
    });

    // Partner A's partner-wide grant pinned on an org-A1 session, from org A1's own context: accepted.
    const [pinned] = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () => db.insert(aiSessions).values({
      orgId: f.orgA1, model: 'claude-sonnet-5-5', wispGrantId: f.grantA.grantId, wispGrantRevisionId: f.grantA.revisionId,
    }).returning({ id: aiSessions.id, g: aiSessions.wispGrantId }));
    expect(pinned).toMatchObject({ g: f.grantA.grantId });

    // Partner B's grant, from the same org-A1 context: refused.
    await tenantGuardRefusal(f.orgA1, f.partnerA, f.orgA1, f.grantB);

    // An org-A1-scoped grant pinned from an org-A2 context (same partner): refused.
    const grantor = await asSystem(async () => (await db.select({ u: wispGrants.grantorUserId }).from(wispGrants)
      .where(eq(wispGrants.id, f.grantA.grantId)))[0]!.u);
    const scopedA1 = await seedGrant(f.partnerA, grantor, [f.orgA1], f.orgA1);
    await tenantGuardRefusal(f.orgA2, f.partnerA, f.orgA2, scopedA1);
  });

  it('focus_org_id: an org from another partner is refused (23503); deleting the focus org sets focus_org_id NULL and keeps partner_id', async () => {
    const f = await seed();
    await expectSqlState(
      () => insertThread(f.grantA.grantId, f.partnerA, { focusOrgId: f.orgB1 }),
      '23503',
      'wisp_threads_focus_org_fk',
    );
    const thread = await insertThread(f.grantA.grantId, f.partnerA, { focusOrgId: f.orgA2 });
    expect(thread.focusOrgId).toBe(f.orgA2);

    await asSystem(async () => {
      await db.delete(organizations).where(eq(organizations.id, f.orgA2));
      const [after] = await db.select().from(wispThreads).where(eq(wispThreads.id, thread.id));
      expect(after!.focusOrgId).toBeNull();
      expect(after!.partnerId).toBe(f.partnerA);
    });
  });
});

describe('wisp_thread_attachments RLS (shape 1)', () => {
  it("an org context reads its own attachment and not a sibling org's; cross-org insert is 42501; artifact_id must match the artifact's org (23503)", async () => {
    const f = await seed();
    const thread = await insertThread(f.grantA.grantId, f.partnerA);
    const artA1 = await insertArtifact(f.orgA1);
    const artA2 = await insertArtifact(f.orgA2);
    const [attA1, attA2] = await asSystem(() => db.insert(wispThreadAttachments).values([
      { threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId: artA1, label: 'a1 notes' },
      { threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA2, artifactId: artA2, label: 'a2 notes' },
    ]).returning({ id: wispThreadAttachments.id }));
    const artA2b = await insertArtifact(f.orgA2);

    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      const rows = await db.select({ id: wispThreadAttachments.id }).from(wispThreadAttachments)
        .where(inArray(wispThreadAttachments.id, [attA1!.id, attA2!.id]));
      expect(rows.map((r) => r.id)).toEqual([attA1!.id]);
    });

    // Cross-org insert: org A1 forging an org A2 row.
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.insert(wispThreadAttachments).values({
          threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA2, artifactId: artA2b, label: 'forged',
        })),
      '42501',
    );

    // A sibling partner sees none of them.
    await withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), async () => {
      const rows = await db.select({ id: wispThreadAttachments.id }).from(wispThreadAttachments)
        .where(eq(wispThreadAttachments.threadId, thread.id));
      expect(rows).toHaveLength(0);
    });

    // The attachment's org must be the artifact's org.
    const artA2c = await insertArtifact(f.orgA2);
    await expectSqlState(
      () => asSystem(() => db.insert(wispThreadAttachments).values({
        threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId: artA2c, label: 'mismatch',
      })),
      '23503',
      'wisp_thread_attachments_artifact_fk',
    );
    // And the org must belong to the thread's partner.
    const artB1 = await insertArtifact(f.orgB1);
    await expectSqlState(
      () => asSystem(() => db.insert(wispThreadAttachments).values({
        threadId: thread.id, partnerId: f.partnerA, orgId: f.orgB1, artifactId: artB1, label: 'other partner',
      })),
      '23503',
      'wisp_thread_attachments_org_fk',
    );
  });

  it('deleting the ai_run_artifacts row cascades the attachment; deleting the thread cascades its attachments', async () => {
    const f = await seed();
    const thread = await insertThread(f.grantA.grantId, f.partnerA);
    const art1 = await insertArtifact(f.orgA1);
    const art2 = await insertArtifact(f.orgA1);
    const [att1, att2] = await asSystem(() => db.insert(wispThreadAttachments).values([
      { threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId: art1, label: 'one' },
      { threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId: art2, label: 'two' },
    ]).returning({ id: wispThreadAttachments.id }));

    await asSystem(async () => {
      await db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, art1));
      expect(await db.select().from(wispThreadAttachments).where(eq(wispThreadAttachments.id, att1!.id))).toEqual([]);
      expect(await db.select().from(wispThreadAttachments).where(eq(wispThreadAttachments.id, att2!.id))).toHaveLength(1);

      await db.delete(wispThreads).where(eq(wispThreads.id, thread.id));
      expect(await db.select().from(wispThreadAttachments).where(eq(wispThreadAttachments.id, att2!.id))).toEqual([]);
      // The artifact itself outlives the attachment row.
      expect(await db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, art2))).toHaveLength(1);
    });
  });

  it('an attachment uploaded in session 1 is found by findArtifactForCaller from session 2 of the same thread, and NOT from a session on another thread in the same org', async () => {
    const { findArtifactForCaller } = await import('../../services/artifacts/artifactService');
    const f = await seed();
    const grantor = await asSystem(async () => (await db.select({ u: wispGrants.grantorUserId }).from(wispGrants)
      .where(eq(wispGrants.id, f.grantA.grantId)))[0]!.u);
    // A second live grant (hence a second thread) in the same partner needs a
    // second grantor (one live grant per grantor and scope).
    const otherUser = await createUser({ partnerId: f.partnerA, email: `wisp-thread-a2-${randomUUID()}@wisp.test` });
    const otherGrant = await seedGrant(f.partnerA, otherUser.id, [f.orgA1, f.orgA2]);
    const thread = await insertThread(f.grantA.grantId, f.partnerA, { focusOrgId: f.orgA1 });
    const otherThread = await insertThread(otherGrant.grantId, f.partnerA, { focusOrgId: f.orgA1 });
    const session1 = await insertSession(f.orgA1);
    const session2 = await insertSession(f.orgA1);
    const sessionOther = await insertSession(f.orgA1);
    await asSystem(() => db.insert(wispThreadSessions).values([
      { threadId: thread.id, sessionId: session1, partnerId: f.partnerA, orgId: f.orgA1 },
      { threadId: thread.id, sessionId: session2, partnerId: f.partnerA, orgId: f.orgA1 },
      { threadId: otherThread.id, sessionId: sessionOther, partnerId: f.partnerA, orgId: f.orgA1 },
    ]));
    // What addThreadAttachment writes: a session-less, redacted input_capture
    // artifact plus the attachment row (uploaded while session 1 was live).
    const artifactId = await insertArtifact(f.orgA1);
    await asSystem(() => db.insert(wispThreadAttachments).values({
      threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId, label: 'notes', addedByUserId: grantor,
    }));

    // The read_artifact path runs in the caller's org-scoped request context.
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      const fromSession2 = await findArtifactForCaller(artifactId, { orgId: f.orgA1, sessionId: session2, wispThreadId: thread.id });
      expect(fromSession2?.id).toBe(artifactId);
      const fromSession1 = await findArtifactForCaller(artifactId, { orgId: f.orgA1, sessionId: session1, wispThreadId: thread.id });
      expect(fromSession1?.id).toBe(artifactId);

      // Another thread of the same partner and org: not a match.
      expect(await findArtifactForCaller(artifactId, { orgId: f.orgA1, sessionId: sessionOther, wispThreadId: otherThread.id })).toBeNull();
      // No thread pointer: the exact-session rule still refuses (session_id is NULL).
      expect(await findArtifactForCaller(artifactId, { orgId: f.orgA1, sessionId: session2 })).toBeNull();
      // The org predicate still binds: the right thread from another org's anchor is refused.
      expect(await findArtifactForCaller(artifactId, { orgId: f.orgA2, sessionId: session2, wispThreadId: thread.id })).toBeNull();
    });
  });

  it('addThreadAttachment stores a redacted artifact + row under the thread lock, lists it newest first, and refuses the 21st live attachment', async () => {
    const { createMemoryBlobStorage, setBlobStorageForTests } = await import('../../services/artifacts/blobStorage');
    const { addThreadAttachment, listThreadAttachments, ThreadAttachmentError } = await import('../../services/wisp/threadAttachments');
    const blobs = createMemoryBlobStorage();
    setBlobStorageForTests(blobs);
    try {
      const f = await seed();
      const row = await insertThread(f.grantA.grantId, f.partnerA, { focusOrgId: f.orgA1 });
      const grantor = await asSystem(async () => (await db.select({ u: wispGrants.grantorUserId }).from(wispGrants)
        .where(eq(wispGrants.id, f.grantA.grantId)))[0]!.u);
      const thread = { ...row, summary: row.summary ?? '' };
      const ceiling = {
        grantId: f.grantA.grantId, revisionId: f.grantA.revisionId, partnerId: f.partnerA, grantorUserId: grantor,
        scopeOrgId: null, partnerWide: true, orgIds: new Set([f.orgA1, f.orgA2]), siteIds: null,
        permissionKeys: new Set(['ai_sessions:use']), toolAllowlist: null, deniedTools: new Set<string>(),
        orgTerms: new Map(), status: 'active' as const,
      };

      const added = await addThreadAttachment({
        thread, ceiling, orgId: f.orgA1, label: 'creds.txt', text: 'password=hunter2\nok', addedByUserId: grantor,
      });
      const [artifact] = await asSystem(() => db.select().from(aiRunArtifacts).where(eq(aiRunArtifacts.id, added.artifactId)));
      expect(artifact).toMatchObject({ orgId: f.orgA1, sessionId: null, runId: null, kind: 'input_capture', name: 'creds.redacted.txt', createdByTool: 'wisp_thread_attachment' });
      const stored = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        void blobs.openStream(artifact!.blobKey).then((s) => s
          .on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
          .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          .on('error', reject));
      });
      expect(stored).not.toContain('hunter2');

      expect((await listThreadAttachments(thread.id)).map((a) => a.id)).toEqual([added.id]);

      // 19 more live attachments (direct rows), then the 21st is refused before any blob write.
      for (let i = 0; i < 19; i++) {
        const art = await insertArtifact(f.orgA1);
        await asSystem(() => db.insert(wispThreadAttachments).values({
          threadId: thread.id, partnerId: f.partnerA, orgId: f.orgA1, artifactId: art, label: `n${i}`,
        }));
      }
      const listed = await listThreadAttachments(thread.id);
      expect(listed).toHaveLength(20);
      expect(listed[listed.length - 1]!.id).toBe(added.id);
      const before = await asSystem(() => db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.orgId, f.orgA1)));
      const err = await addThreadAttachment({ thread, ceiling, orgId: f.orgA1, label: 'x.txt', text: 'x', addedByUserId: grantor })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ThreadAttachmentError);
      expect((err as InstanceType<typeof ThreadAttachmentError>).code).toBe('too_many');
      const after = await asSystem(() => db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.orgId, f.orgA1)));
      expect(after).toHaveLength(before.length);

      // An expired artifact frees its slot.
      await asSystem(() => db.update(aiRunArtifacts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(aiRunArtifacts.id, listed[0]!.artifactId)));
      expect(await listThreadAttachments(thread.id)).toHaveLength(19);
      await expect(addThreadAttachment({ thread, ceiling, orgId: f.orgA1, label: 'y.csv', text: 'a,b', addedByUserId: grantor }))
        .resolves.toMatchObject({ contentType: 'text/csv', label: 'y.csv' });
    } finally {
      setBlobStorageForTests(null);
    }
  });
});

describe('finalizeWispSessionSummary (W04 T5, Review Focus 5)', () => {
  it("each partner's thread holds only its own session's last assistant paragraph", async () => {
    const { finalizeWispSessionSummary } = await import('../../services/wisp/threadSummary');
    const f = await seed();
    const threadA = await insertThread(f.grantA.grantId, f.partnerA);
    const threadB = await insertThread(f.grantB.grantId, f.partnerB);
    const sessionA = await insertSession(f.orgA1);
    const sessionB = await insertSession(f.orgB1);
    await asSystem(async () => {
      await db.insert(wispThreadSessions).values([
        { threadId: threadA.id, sessionId: sessionA, partnerId: f.partnerA, orgId: f.orgA1 },
        { threadId: threadB.id, sessionId: sessionB, partnerId: f.partnerB, orgId: f.orgB1 },
      ]);
      await db.insert(aiMessages).values([
        { sessionId: sessionA, role: 'assistant', content: 'A intro.\n\nA conclusion: partner A backups are green.' },
        { sessionId: sessionB, role: 'assistant', content: 'B intro.\n\nB conclusion: partner B patching is late.' },
      ]);
    });

    await expect(finalizeWispSessionSummary(sessionA)).resolves.toEqual({ updated: true });
    await expect(finalizeWispSessionSummary(sessionB)).resolves.toEqual({ updated: true });

    const summaries = await asSystem(() => db
      .select({ id: wispThreads.id, summary: wispThreads.summary })
      .from(wispThreads)
      .where(inArray(wispThreads.id, [threadA.id, threadB.id])));
    const byId = new Map(summaries.map((r) => [r.id, r.summary]));
    expect(byId.get(threadA.id)).toBe('A conclusion: partner A backups are green.');
    expect(byId.get(threadB.id)).toBe('B conclusion: partner B patching is late.');

    // Idempotent: a second finalize writes nothing.
    await expect(finalizeWispSessionSummary(sessionA)).resolves.toEqual({ updated: false });
  });
});
