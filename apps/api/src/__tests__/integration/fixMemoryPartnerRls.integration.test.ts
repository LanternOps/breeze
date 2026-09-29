import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { fixMemory, fixOutcomes } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId,
});
const orgContext = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

async function expectSqlState(fn: () => Promise<unknown>, code: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const KEY = 'a'.repeat(64);
const memoryRow = (owner: { orgId?: string | null; partnerId?: string | null }) => ({
  orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
  signatureVersion: 1, signatureKey: KEY, broadKey: KEY, osType: 'windows',
  fixKind: 'builtin_action' as const, fixIdentity: `builtin:reboot:${randomUUID()}`, builtinAction: 'reboot',
});
const outcomeRow = (orgId: string, partnerId: string) => ({
  orgId, partnerId, deviceId: randomUUID(), sourceType: 'alert' as const, sourceId: randomUUID(),
  fixKind: 'builtin_action' as const, deadlineAt: new Date(Date.now() + 3_600_000),
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id };
}

const createdMemory: string[] = [];
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdMemory.length) await db.delete(fixMemory).where(inArray(fixMemory.id, createdMemory.splice(0)));
  });
});

async function seedMemory(owner: { orgId?: string | null; partnerId?: string | null }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(fixMemory).values(memoryRow(owner)).returning());
  createdMemory.push(row!.id);
  return row!;
}

describe('fix_memory / fix_outcomes RLS', () => {
  it('forbids forging another tenant’s rows (42501)', async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
      db.insert(fixMemory).values(memoryRow({ orgId: f.orgA1 }))), '42501');
    await expectSqlState(() => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
      db.insert(fixMemory).values(memoryRow({ partnerId: f.partnerA }))), '42501');
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
      db.insert(fixOutcomes).values(outcomeRow(f.orgA1, f.partnerA))), '42501');
  });

  it('enforces the XOR owner check (23514)', async () => {
    const f = await fixture();
    for (const owner of [{ orgId: null, partnerId: null }, { orgId: f.orgA1, partnerId: f.partnerA }]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(fixMemory).values(memoryRow(owner))), '23514');
    }
  });

  it('rejects an outcome whose partner does not own its org (23503)', async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(fixOutcomes).values(outcomeRow(f.orgA1, f.partnerB))), '23503');
  });

  it('org tokens read their partner’s rows through the SELECT branch but cannot write them', async () => {
    const f = await fixture();
    const row = await seedMemory({ partnerId: f.partnerA });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toHaveLength(1);
      expect(await db.update(fixMemory).set({ attempts: 99 }).where(eq(fixMemory.id, row.id)).returning()).toEqual([]);
      expect(await db.delete(fixMemory).where(eq(fixMemory.id, row.id)).returning()).toEqual([]);
    });
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.insert(fixMemory).values(memoryRow({ partnerId: f.partnerA }))), '42501');
  });

  it('never shows another partner’s rows or a sibling org’s private rows', async () => {
    const f = await fixture();
    const partnerRow = await seedMemory({ partnerId: f.partnerA });
    const privateRow = await seedMemory({ orgId: f.orgA1 });
    await withDbAccessContext(orgContext(f.orgB1, f.partnerB), async () => {
      expect(await db.select().from(fixMemory).where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).toEqual([]);
    });
    await withDbAccessContext(orgContext(f.orgA2, f.partnerA), async () => {
      const ids = (await db.select({ id: fixMemory.id }).from(fixMemory)
        .where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).map((r) => r.id);
      expect(ids).toEqual([partnerRow.id]);
    });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      const ids = (await db.select({ id: fixMemory.id }).from(fixMemory)
        .where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).map((r) => r.id).sort();
      expect(ids).toEqual([partnerRow.id, privateRow.id].sort());
    });
  });

  it('headless agent-auth context (org-scoped, no partner access, currentPartnerId set) reads partner memory; without currentPartnerId it does not', async () => {
    const f = await fixture();
    const row = await seedMemory({ partnerId: f.partnerA });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toHaveLength(1);
    });
    await withDbAccessContext(orgContext(f.orgA1, null), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toEqual([]);
    });
  });
});
