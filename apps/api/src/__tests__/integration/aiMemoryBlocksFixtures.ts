/**
 * Shared fixtures for the Wisp W03 memory suites (ai_memory_blocks RLS + the
 * memory broker). Real Postgres via the integration harness; every write goes
 * through `withDbAccessContext` so the app pool's RLS is in force.
 *
 * Tenancy: partners A and B; orgs A1, A2 (partner A) and B1 (partner B); MSP
 * staff users uA1, uA2 (partner A) and uB1 (partner B).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { expect } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiMemoryBlocks, aiSessions, type AiMemoryBlockRow } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

export const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

export const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId,
});

export const orgContext = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

/** A signed-in MSP technician: partner scope, own user id, own partner as current. */
export const userContext = (userId: string, partnerId: string): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId, currentPartnerId: partnerId,
});

export async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

export type MemoryFixture = {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB1: string;
  uA1: string; uA2: string; uB1: string;
};

export async function seedMemoryFixture(): Promise<MemoryFixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const uA1 = await createUser({ partnerId: partnerA.id, email: `ua1-${randomUUID()}@example.com` });
  const uA2 = await createUser({ partnerId: partnerA.id, email: `ua2-${randomUUID()}@example.com` });
  const uB1 = await createUser({ partnerId: partnerB.id, email: `ub1-${randomUUID()}@example.com` });
  return {
    partnerA: partnerA.id, partnerB: partnerB.id,
    orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    uA1: uA1.id, uA2: uA2.id, uB1: uB1.id,
  };
}

export type MemoryOwnerSpec =
  | { kind: 'user'; userId: string }
  | { kind: 'org'; orgId: string }
  | { kind: 'partner' };

export type BlockValues = typeof aiMemoryBlocks.$inferInsert;

/** Build insert values for one block; `overrides` wins (including raw owner columns). */
export function blockValues(
  tenantPartnerId: string,
  owner: MemoryOwnerSpec,
  overrides: Partial<BlockValues> = {},
): BlockValues {
  return {
    tenantPartnerId,
    ownerKind: owner.kind,
    ownerUserId: owner.kind === 'user' ? owner.userId : null,
    ownerOrgId: owner.kind === 'org' ? owner.orgId : null,
    blockType: 'fact',
    subjectKey: `subject:${randomUUID()}`,
    content: { text: 'remembered' },
    ...overrides,
  };
}

const insertedBlockIds: string[] = [];

/** Insert one block under system scope (the broker's path) and track it for cleanup. */
export async function insertBlock(
  tenantPartnerId: string,
  owner: MemoryOwnerSpec,
  overrides: Partial<BlockValues> = {},
): Promise<AiMemoryBlockRow> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiMemoryBlocks).values(blockValues(tenantPartnerId, owner, overrides)).returning());
  insertedBlockIds.push(row!.id);
  return row!;
}

/** Insert an ai_sessions row (org-scoped, optional user) under system scope. */
export async function insertAiSession(orgId: string, userId: string | null = null): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiSessions).values({ orgId, userId, model: 'claude-test' }).returning({ id: aiSessions.id }));
  return row!.id;
}

/**
 * Delete every block `insertBlock` created. The harness's beforeEach TRUNCATE
 * of partners CASCADE also clears the table; this keeps a suite independent of
 * that ordering.
 */
export async function cleanupMemoryBlocks(): Promise<void> {
  const ids = insertedBlockIds.splice(0);
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () => db.delete(aiMemoryBlocks).where(inArray(aiMemoryBlocks.id, ids)));
}
