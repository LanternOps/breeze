/**
 * portal_access_requests: RLS, FK and org-merge proofs (W3 #11380, plan Task 2).
 * Task 7 appends the service-level cases in a separate describe block.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { portalAccessPolicies, portalAccessRequests, portalUsers } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { runPolicy } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

function orgContext(orgId: string, currentPartnerId: string | null = null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId,
  };
}

const requestIds: string[] = [];
const policyIds: string[] = [];
const portalUserIds: string[] = [];

afterEach(async () => {
  const r = [...new Set(requestIds)]; requestIds.length = 0;
  const p = [...new Set(policyIds)]; policyIds.length = 0;
  const u = [...new Set(portalUserIds)]; portalUserIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (r.length) await db.delete(portalAccessRequests).where(inArray(portalAccessRequests.id, r));
    if (p.length) await db.delete(portalAccessPolicies).where(inArray(portalAccessPolicies.id, p));
    if (u.length) await db.delete(portalUsers).where(inArray(portalUsers.id, u));
  });
});

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

async function seedRequest(orgId: string, email: string, extra: Partial<typeof portalAccessRequests.$inferInsert> = {}) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(portalAccessRequests).values({
      orgId, email, source: 'self', expiresAt: inDays(7), ...extra,
    }).returning({ id: portalAccessRequests.id }));
  requestIds.push(row!.id);
  return row!.id;
}

async function seedPolicy(values: { orgId?: string; partnerId?: string }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(portalAccessPolicies).values({ ...values, passwordMode: 'sso_only' })
      .returning({ id: portalAccessPolicies.id }));
  policyIds.push(row!.id);
  return row!.id;
}

async function existingPolicyIds(ids: string[]) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: portalAccessPolicies.id }).from(portalAccessPolicies)
      .where(inArray(portalAccessPolicies.id, ids)));
  return rows.map((r) => r.id).sort();
}

async function existingRequestIds(ids: string[]) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: portalAccessRequests.id }).from(portalAccessRequests)
      .where(inArray(portalAccessRequests.id, ids)));
  return rows.map((r) => r.id).sort();
}

async function runMerge(table: string, loserOrgId: string, survivorOrgId: string) {
  const policy = getOrgMergePolicies().get(table);
  expect(policy, `merge policy for ${table}`).toBeDefined();
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const phase of ['resolve', 'move'] as const) {
      await runPolicy(table, policy!, loserOrgId, survivorOrgId, phase);
    }
  });
}

describe('RLS, FK and merge', () => {
  it('org A context cannot see or insert org B requests (0 rows / 42501)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const bId = await seedRequest(orgB.id, `b-${randomUUID()}@example.test`);
    const seen = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
      db.select().from(portalAccessRequests).where(eq(portalAccessRequests.id, bId)));
    expect(seen).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(orgContext(orgA.id, partner.id), () =>
        db.insert(portalAccessRequests).values({
          orgId: orgB.id, email: `x-${randomUUID()}@example.test`, source: 'self', expiresAt: inDays(7),
        }).returning()),
      '42501',
    );
  });

  it('deleting the portal user deletes requests that reference it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [pu] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(portalUsers).values({
        orgId: org.id, email: `pu-${randomUUID()}@example.test`, authMethod: 'password',
      }).returning({ id: portalUsers.id }));
    portalUserIds.push(pu!.id);
    const reqId = await seedRequest(org.id, `pu-${randomUUID()}@example.test`, {
      source: 'addin_user', portalUserId: pu!.id,
    });
    expect(await existingRequestIds([reqId])).toEqual([reqId]);
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(portalUsers).where(eq(portalUsers.id, pu!.id)));
    expect(await existingRequestIds([reqId])).toEqual([]);
  });

  it('merge keeps the survivor policy and dedupes pending requests by email', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const loserPolicy = await seedPolicy({ orgId: loser.id });
    const survivorPolicy = await seedPolicy({ orgId: survivor.id });
    const dup = `dup-${randomUUID()}@example.test`;
    const loserDup = await seedRequest(loser.id, dup);
    const survivorDup = await seedRequest(survivor.id, dup);

    expect(getOrgMergePolicies().get('portal_access_policies')).toEqual({ kind: 'keep-survivor' });
    await runMerge('portal_access_policies', loser.id, survivor.id);
    await runMerge('portal_access_requests', loser.id, survivor.id); // must not 23505

    expect(await existingPolicyIds([loserPolicy, survivorPolicy])).toEqual([survivorPolicy]);
    expect(await existingRequestIds([loserDup, survivorDup])).toEqual([survivorDup]);
  });

  it('merge drops the loser override when the survivor has none: the survivor stays on the partner default', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const partnerDefault = await seedPolicy({ partnerId: partner.id });
    const loserPolicy = await seedPolicy({ orgId: loser.id });

    await runMerge('portal_access_policies', loser.id, survivor.id);

    expect(await existingPolicyIds([partnerDefault, loserPolicy])).toEqual([partnerDefault]);
    const survivorRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: portalAccessPolicies.id }).from(portalAccessPolicies)
        .where(eq(portalAccessPolicies.orgId, survivor.id)));
    expect(survivorRows).toHaveLength(0);
  });

  it("merge moves the loser's non-colliding and decided requests to the survivor", async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const email = `same-${randomUUID()}@example.test`;
    const pendingOnly = await seedRequest(loser.id, `only-${randomUUID()}@example.test`);
    // Decided rows sit outside the pending-only unique index: they move even on an email collision.
    const denied = await seedRequest(loser.id, email, { status: 'denied', decidedAt: new Date() });
    const survivorPending = await seedRequest(survivor.id, email);

    await runMerge('portal_access_requests', loser.id, survivor.id);

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: portalAccessRequests.id, orgId: portalAccessRequests.orgId }).from(portalAccessRequests)
        .where(inArray(portalAccessRequests.id, [pendingOnly, denied, survivorPending])));
    const byId = new Map(rows.map((r) => [r.id, r.orgId]));
    expect(byId.size).toBe(3);
    for (const id of [pendingOnly, denied, survivorPending]) expect(byId.get(id)).toBe(survivor.id);
  });
});
