/**
 * ai_memory_blocks (Wisp W03, #9906): owner_kind-branched RLS on a
 * partner-axis anchor, the owner-shape CHECK, the anchor-bound composite FKs,
 * and the FK-cascade erasure paths that stand in for the org cascade / merge /
 * export registries (the table has no org_id column — see the migration header).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiMemoryBlocks, aiSessions, auditLogs, organizations, partners, users } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  MemoryServiceError, confirmBlock, listBlocksForUser, listUserBlocksForPartnerAdmin, recordHumanBlock, retractBlock,
} from '../../services/wisp/memoryService';
import {
  SYSTEM_CTX, blockValues, cleanupMemoryBlocks, expectSqlState, insertAiSession, insertBlock,
  orgContext, partnerContext, seedMemoryFixture, userContext,
} from './aiMemoryBlocksFixtures';

afterEach(cleanupMemoryBlocks);

const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe('ai_memory_blocks RLS (owner_kind-branched)', () => {
  it('enforces the three-way owner CHECK (23514)', async () => {
    const f = await seedMemoryFixture();
    const bad = [
      // user kind with org set
      blockValues(f.partnerA, { kind: 'user', userId: f.uA1 }, { ownerOrgId: f.orgA1 }),
      // org kind with user set
      blockValues(f.partnerA, { kind: 'org', orgId: f.orgA1 }, { ownerUserId: f.uA1 }),
      // partner kind with either set
      blockValues(f.partnerA, { kind: 'partner' }, { ownerUserId: f.uA1 }),
      blockValues(f.partnerA, { kind: 'partner' }, { ownerOrgId: f.orgA1 }),
      // user kind with both NULL
      blockValues(f.partnerA, { kind: 'user', userId: f.uA1 }, { ownerUserId: null }),
      // a grant revision without its grant (provenance pair: revision ⇒ grant)
      blockValues(f.partnerA, { kind: 'user', userId: f.uA1 }, { authoredByGrantId: null, authoredByGrantRevisionId: randomUUID() }),
    ];
    for (const values of bad) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(aiMemoryBlocks).values(values)), '23514');
    }
    // and the closed value sets
    for (const overrides of [
      { ownerKind: 'team' as never },
      { blockType: 'rumor' as never },
      { confidence: 'certain' as never },
      { status: 'archived' as never },
    ]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'partner' }, overrides))), '23514');
    }
  });

  it('rejects an owner outside the anchor partner (23503)', async () => {
    const f = await seedMemoryFixture();
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'user', userId: f.uB1 }))), '23503');
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'org', orgId: f.orgB1 }))), '23503');
  });

  it('cross-partner forge fails 42501', async () => {
    const f = await seedMemoryFixture();
    await expectSqlState(() => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'partner' }))), '42501');
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'org', orgId: f.orgA1 }))), '42501');
    // A user cannot author a block owned by a colleague, nor one anchored to another partner.
    await expectSqlState(() => withDbAccessContext(userContext(f.uA2, f.partnerA), () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'user', userId: f.uA1 }))), '42501');
    await expectSqlState(() => withDbAccessContext(userContext(f.uB1, f.partnerB), () =>
      db.insert(aiMemoryBlocks).values(blockValues(f.partnerA, { kind: 'user', userId: f.uB1 }))), '42501');
  });

  it('user A cannot read user B’s block in the same partner', async () => {
    const f = await seedMemoryFixture();
    const row = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 });
    await withDbAccessContext(userContext(f.uA2, f.partnerA), async () => {
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, row.id))).toEqual([]);
      expect(await db.update(aiMemoryBlocks).set({ status: 'retracted' }).where(eq(aiMemoryBlocks.id, row.id)).returning()).toEqual([]);
      expect(await db.delete(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, row.id)).returning()).toEqual([]);
    });
    // control: the owner sees, updates, and keeps their own block
    await withDbAccessContext(userContext(f.uA1, f.partnerA), async () => {
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, row.id)))).toEqual([row.id]);
      const updated = await db.update(aiMemoryBlocks).set({ status: 'confirmed' }).where(eq(aiMemoryBlocks.id, row.id)).returning();
      expect(updated.map((r) => r.status)).toEqual(['confirmed']);
    });
  });

  it('org-scoped context reads zero user rows', async () => {
    const f = await seedMemoryFixture();
    const subjectKey = 'device:printer-queue';
    const userRow = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }, { subjectKey });
    const orgRow = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }, { subjectKey });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      const ids = idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks)
        .where(inArray(aiMemoryBlocks.id, [userRow.id, orgRow.id])));
      expect(ids).toEqual([orgRow.id]);
    });
  });

  it('org rows follow org access; partner rows follow partner access', async () => {
    const f = await seedMemoryFixture();
    const orgA1Row = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 });
    const orgA2Row = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA2 });
    const partnerRow = await insertBlock(f.partnerA, { kind: 'partner' });
    const all = [orgA1Row.id, orgA2Row.id, partnerRow.id];

    // A sibling org sees only its own org row.
    await withDbAccessContext(orgContext(f.orgA2, f.partnerA), async () => {
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, all))))
        .toEqual([orgA2Row.id]);
    });
    // No partner-wide SELECT branch for org tokens: A1 does not see the partner row.
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, all))))
        .toEqual([orgA1Row.id]);
    });
    // The partner sees its partner row and both org rows.
    await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), async () => {
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, all))))
        .toEqual([...all].sort());
    });
    // Another partner sees none of them.
    await withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), async () => {
      expect(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, all))).toEqual([]);
    });
  });

  it('system scope reads everything (the broker path)', async () => {
    const f = await seedMemoryFixture();
    const rows = [
      await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }),
      await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }),
      await insertBlock(f.partnerA, { kind: 'partner' }),
      await insertBlock(f.partnerB, { kind: 'user', userId: f.uB1 }),
      await insertBlock(f.partnerB, { kind: 'org', orgId: f.orgB1 }),
    ];
    const ids = rows.map((r) => r.id);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, ids))))
        .toEqual([...ids].sort());
    });
  });

  it('owner deletion cascades: deleting the org removes its blocks; deleting the user removes theirs', async () => {
    const f = await seedMemoryFixture();
    const orgRow = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA2 });
    const userRow = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA2 });
    const survivor = await insertBlock(f.partnerA, { kind: 'partner' });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(organizations).where(eq(organizations.id, f.orgA2));
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, orgRow.id))).toEqual([]);
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, userRow.id))).toHaveLength(1);

      await db.delete(users).where(eq(users.id, f.uA2));
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, userRow.id))).toEqual([]);
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, survivor.id))).toHaveLength(1);
    });
  });

  it('source_session_id: a block_type of work_summary is accepted; deleting the ai_sessions row sets source_session_id NULL and keeps the block', async () => {
    const f = await seedMemoryFixture();
    const sessionId = await insertAiSession(f.orgA1, f.uA1);
    const row = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }, {
      blockType: 'work_summary', sourceSessionId: sessionId, content: { summary: 'patched 3 devices', evidence: [] },
    });
    expect(row.blockType).toBe('work_summary');
    expect(row.sourceSessionId).toBe(sessionId);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(aiSessions).where(eq(aiSessions.id, sessionId));
      const [after] = await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, row.id));
      expect(after).toBeDefined();
      expect(after!.sourceSessionId).toBeNull();
    });
  });

  it('superseded_by_id: deleting the newer block nulls the pointer on the older one', async () => {
    const f = await seedMemoryFixture();
    const newer = await insertBlock(f.partnerA, { kind: 'partner' });
    const older = await insertBlock(f.partnerA, { kind: 'partner' }, { supersededById: newer.id });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, newer.id));
      const [after] = await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, older.id));
      expect(after!.supersededById).toBeNull();
    });
  });

  it('partner erasure path: deleting the partner row removes user-, org- and partner-owned blocks', async () => {
    const f = await seedMemoryFixture();
    const rows = [
      await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }),
      await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 }),
      await insertBlock(f.partnerA, { kind: 'partner' }),
    ];
    const partnerRow = rows[2]!;
    const other = await insertBlock(f.partnerB, { kind: 'partner' });
    const ids = rows.map((r) => r.id);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      // Same order as cascadeDeletePartner: child orgs and users first, the partner row last.
      await db.delete(organizations).where(eq(organizations.partnerId, f.partnerA));
      await db.delete(users).where(eq(users.partnerId, f.partnerA));
      // The partner-owned block outlives its sibling owners; only the anchor FK removes it.
      expect(idsOf(await db.select({ id: aiMemoryBlocks.id }).from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, ids))))
        .toEqual([partnerRow.id]);
      await db.delete(partners).where(eq(partners.id, f.partnerA));
      expect(await db.select().from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, ids))).toEqual([]);
      expect(await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, other.id))).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// memoryService (Task 4 / Task 12) under real RLS. The DbAccessContext and the
// AuthContext are built from the same facts, the way authMiddleware builds both.
// ---------------------------------------------------------------------------

type Session = { auth: AuthContext; ctx: DbAccessContext };

/** A signed-in MSP technician (partner scope, interactive session). */
function partnerSession(userId: string, partnerId: string, orgIds: string[], partnerOrgAccess: 'all' | 'selected'): Session {
  return {
    auth: {
      principal: { kind: 'user_session' },
      user: { id: userId, email: `${userId}@example.com`, name: 'Tech', isPlatformAdmin: false },
      token: null, partnerId, orgId: null, scope: 'partner', accessibleOrgIds: orgIds, partnerOrgAccess,
      orgCondition: () => undefined, canAccessOrg: (id: string) => orgIds.includes(id),
    } as AuthContext,
    ctx: { ...partnerContext(partnerId, orgIds), userId },
  };
}

/** An organization-session user: org JWTs carry no partnerId (middleware/auth.ts). */
function orgSession(userId: string, orgId: string): Session {
  return {
    auth: {
      principal: { kind: 'user_session' },
      user: { id: userId, email: `${userId}@example.com`, name: 'Org tech', isPlatformAdmin: false },
      token: null, partnerId: null, orgId, scope: 'organization', accessibleOrgIds: [orgId],
      orgCondition: () => undefined, canAccessOrg: (id: string) => id === orgId,
    } as AuthContext,
    ctx: { ...orgContext(orgId, null), userId },
  };
}

const as = <T>(s: Session, fn: (auth: AuthContext) => Promise<T>) => withDbAccessContext(s.ctx, () => fn(s.auth));

async function serviceCode(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(MemoryServiceError);
    return (err as MemoryServiceError).code;
  }
  return undefined;
}

async function readBlock(id: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, id)));
  return row;
}

describe('memoryService under RLS', () => {
  it('memoryService: user A confirms their own block; user B’s confirm of it is not_found', async () => {
    const f = await seedMemoryFixture();
    const row = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 });
    const a = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2], 'selected');
    const b = partnerSession(f.uA2, f.partnerA, [f.orgA1, f.orgA2], 'all');

    expect(await serviceCode(as(b, (auth) => confirmBlock(auth, row.id)))).toBe('not_found');
    expect(await serviceCode(as(b, (auth) => retractBlock(auth, row.id)))).toBe('not_found');
    expect((await readBlock(row.id))!.status).toBe('unconfirmed');

    const confirmed = await as(a, (auth) => confirmBlock(auth, row.id));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    // Review Focus 3: once retracted, a confirm cannot resurrect it.
    await as(a, (auth) => retractBlock(auth, row.id));
    expect(await serviceCode(as(a, (auth) => confirmBlock(auth, row.id)))).toBe('retracted');
    expect((await readBlock(row.id))!.status).toBe('retracted');
  });

  it('memoryService: confirming a block supersedes the other live blocks with the same key (the human choice replaces the old confirmed one)', async () => {
    const f = await seedMemoryFixture();
    const owner = { kind: 'user', userId: f.uA1 } as const;
    const key = { blockType: 'preference', subjectKey: 'ticket.notify' } as const;
    const oldConfirmed = await insertBlock(f.partnerA, owner, { ...key, status: 'confirmed' });
    const proposalA = await insertBlock(f.partnerA, owner, { ...key, status: 'unconfirmed' });
    const proposalB = await insertBlock(f.partnerA, owner, { ...key, status: 'unconfirmed' });
    const retracted = await insertBlock(f.partnerA, owner, { ...key, status: 'retracted' });
    const otherKey = await insertBlock(f.partnerA, owner, { blockType: 'preference', subjectKey: 'ticket.other', status: 'confirmed' });
    const a = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2], 'selected');

    const confirmed = await as(a, (auth) => confirmBlock(auth, proposalB.id));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.supersededById).toBeNull();
    expect((await readBlock(oldConfirmed.id))!.supersededById).toBe(proposalB.id);
    expect((await readBlock(proposalA.id))!.supersededById).toBe(proposalB.id);
    expect((await readBlock(retracted.id))!.supersededById).toBeNull();
    expect((await readBlock(otherKey.id))!.supersededById).toBeNull();
    expect(idsOf(await as(a, (auth) => listBlocksForUser(auth)))).toEqual(idsOf([proposalB, retracted, otherKey]));
  });

  it('memoryService: confirming a block that was already superseded is refused (superseded) and leaves the live block live', async () => {
    const f = await seedMemoryFixture();
    const owner = { kind: 'user', userId: f.uA1 } as const;
    const key = { blockType: 'preference', subjectKey: 'ticket.notify' } as const;
    const live = await insertBlock(f.partnerA, owner, { ...key, status: 'unconfirmed' });
    const stale = await insertBlock(f.partnerA, owner, { ...key, status: 'unconfirmed', supersededById: live.id });
    const a = partnerSession(f.uA1, f.partnerA, [f.orgA1, f.orgA2], 'selected');

    expect(await serviceCode(as(a, (auth) => confirmBlock(auth, stale.id)))).toBe('superseded');
    expect((await readBlock(stale.id))!.status).toBe('unconfirmed');
    expect((await readBlock(live.id))!.supersededById).toBeNull();
    expect(idsOf(await as(a, (auth) => listBlocksForUser(auth)))).toEqual([live.id]);
  });

  it('memoryService: org member retracts an org block; a sibling-org member gets not_found', async () => {
    const f = await seedMemoryFixture();
    const row = await insertBlock(f.partnerA, { kind: 'org', orgId: f.orgA1 });
    expect(await serviceCode(as(orgSession(f.uA2, f.orgA2), (auth) => retractBlock(auth, row.id)))).toBe('not_found');
    expect((await readBlock(row.id))!.status).toBe('unconfirmed');

    const retracted = await as(orgSession(f.uA1, f.orgA1), (auth) => retractBlock(auth, row.id));
    expect(retracted.status).toBe('retracted');
    expect((await readBlock(row.id))!.status).toBe('retracted');
  });

  it('memoryService: partner admin (partnerOrgAccess all) lists another user’s blocks with one audit row; a selected-access admin is refused', async () => {
    const f = await seedMemoryFixture();
    const live = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA2 });
    const retracted = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA2 }, { status: 'retracted' });
    const superseded = await insertBlock(f.partnerA, { kind: 'user', userId: f.uA2 }, { supersededById: live.id });
    await insertBlock(f.partnerA, { kind: 'user', userId: f.uA1 }); // the admin's own: not in the view
    await insertBlock(f.partnerB, { kind: 'user', userId: f.uB1 });
    const orgs = [f.orgA1, f.orgA2];

    const auditRows = (resourceId: string) => withDbAccessContext(SYSTEM_CTX, () => db.select().from(auditLogs).where(and(
      eq(auditLogs.action, 'wisp.memory.user_blocks_viewed'), eq(auditLogs.resourceId, resourceId),
    )));

    // Without the admin view, RLS hides the colleague's private blocks.
    expect(await as(partnerSession(f.uA1, f.partnerA, orgs, 'all'), () =>
      db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, live.id)))).toEqual([]);

    const viewed = await as(partnerSession(f.uA1, f.partnerA, orgs, 'all'), (auth) => listUserBlocksForPartnerAdmin(auth, f.uA2));
    expect(viewed.map((b) => b.id).sort()).toEqual([live.id, retracted.id].sort());
    expect(viewed.map((b) => b.id)).not.toContain(superseded.id);
    const audits = await auditRows(f.uA2);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: f.uA1, partnerId: f.partnerA, orgId: null, resourceType: 'ai_memory_blocks', details: { count: 2 } });

    expect(await serviceCode(as(partnerSession(f.uA1, f.partnerA, orgs, 'selected'), (auth) =>
      listUserBlocksForPartnerAdmin(auth, f.uA2)))).toBe('partner_wide_write_denied');
    // Review Focus 5: a user in another partner is refused even for a full-access admin.
    expect(await serviceCode(as(partnerSession(f.uA1, f.partnerA, orgs, 'all'), (auth) =>
      listUserBlocksForPartnerAdmin(auth, f.uB1)))).toBe('cross_partner');
    expect(await auditRows(f.uA2)).toHaveLength(1);
    expect(await auditRows(f.uB1)).toHaveLength(0);
  });

  it('memoryService.recordHumanBlock: user A records (confirmed, supersedes the prior same-key block); user B in the same partner cannot see it', async () => {
    const f = await seedMemoryFixture();
    const a = partnerSession(f.uA1, f.partnerA, [f.orgA1], 'selected');
    const b = partnerSession(f.uA2, f.partnerA, [f.orgA1], 'all');
    const subjectKey = 'nudge_feedback:device:high';
    const grantId = '99999999-9999-4999-8999-999999999999';
    const input = (verdict: string) => ({
      owner: { kind: 'user' as const }, blockType: 'preference' as const, subjectKey,
      content: { verdict }, confidence: 'high' as const, authoredByGrantId: grantId,
    });

    const first = await as(a, (auth) => recordHumanBlock(auth, input('noisy')));
    const second = await as(a, (auth) => recordHumanBlock(auth, input('useful')));

    expect(second).toMatchObject({
      status: 'confirmed', tenantPartnerId: f.partnerA, owner: { kind: 'user', userId: f.uA1 },
      authoredByGrantId: grantId, authoredByGrantRevisionId: null, supersededById: null,
    });
    expect((await readBlock(first.id))!.supersededById).toBe(second.id);
    expect((await as(a, (auth) => listBlocksForUser(auth))).map((x) => x.id)).toEqual([second.id]);

    // User B (even a full-access admin) sees neither through RLS, and cannot record into A's memory.
    expect(await as(b, () => db.select().from(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, [first.id, second.id])))).toEqual([]);
    expect(await as(b, (auth) => listBlocksForUser(auth))).toEqual([]);
    expect(await serviceCode(as(b, (auth) => recordHumanBlock(auth, { ...input('forged'), owner: { kind: 'user', userId: f.uA1 } }))))
      .toBe('owner_mismatch');

    await withDbAccessContext(SYSTEM_CTX, () => db.delete(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, [first.id, second.id])));
  });
});

