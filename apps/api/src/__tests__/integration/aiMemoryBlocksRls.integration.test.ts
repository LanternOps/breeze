/**
 * ai_memory_blocks (Wisp W03, #9906): owner_kind-branched RLS on a
 * partner-axis anchor, the owner-shape CHECK, the anchor-bound composite FKs,
 * and the FK-cascade erasure paths that stand in for the org cascade / merge /
 * export registries (the table has no org_id column — see the migration header).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { aiMemoryBlocks, aiSessions, organizations, partners, users } from '../../db/schema';
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
