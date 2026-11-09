/**
 * portal_access_policies RLS: dual-axis (org XOR partner) enforcement against
 * real Postgres as breeze_app under FORCE RLS (W3 #11380, plan Task 2).
 * Template: ticketApprovalSettingsPartnerRls.integration.test.ts.
 *
 * Policies (2027-01-22-231500-portal-access-policies-requests.sql):
 *   portal_access_policies_tenant                    FOR ALL
 *   portal_access_policies_partner_default_select    FOR SELECT (current partner)
 *   portal_access_policies_org_member_select         FOR SELECT (any org of the partner)
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { portalAccessPolicies } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { portalOrgDbAccessContext } from '../../routes/portal/portalDbContext';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const createdRowIds: string[] = [];

afterEach(async () => {
  const ids = [...new Set(createdRowIds)];
  createdRowIds.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(portalAccessPolicies).where(inArray(portalAccessPolicies.id, ids)));
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
    userId: null, currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId,
  };
}

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

async function seedRow(values: { orgId?: string | null; partnerId?: string | null; passwordMode?: 'allowed' | 'sso_only' }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(portalAccessPolicies).values({
      orgId: values.orgId ?? null,
      partnerId: values.partnerId ?? null,
      passwordMode: values.passwordMode ?? null,
    }).returning({ id: portalAccessPolicies.id }));
  createdRowIds.push(row!.id);
  return row!.id;
}

async function setup() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  return { partnerA, partnerB, orgA1, orgA2 };
}

describe('portal_access_policies RLS (W3)', () => {
  it('partner A context cannot insert a partner row for partner B (42501)', async () => {
    const { partnerA, partnerB } = await setup();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(partnerA.id, []), () =>
        db.insert(portalAccessPolicies).values({ partnerId: partnerB.id, passwordMode: 'sso_only' }).returning()),
      '42501',
    );
  });

  it('org A context cannot insert or update an org row for org B (42501)', async () => {
    const { partnerA, orgA1, orgA2 } = await setup();
    await expectSqlState(
      () => withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
        db.insert(portalAccessPolicies).values({ orgId: orgA2.id, passwordMode: 'sso_only' }).returning()),
      '42501',
    );
    const id = await seedRow({ orgId: orgA2.id, passwordMode: 'allowed' });
    const updated = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.update(portalAccessPolicies).set({ passwordMode: 'sso_only' })
        .where(eq(portalAccessPolicies.id, id)).returning());
    expect(updated).toHaveLength(0);
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ m: portalAccessPolicies.passwordMode }).from(portalAccessPolicies)
        .where(eq(portalAccessPolicies.id, id)));
    expect(row!.m).toBe('allowed');
  });

  it('org-scoped context sees the partner default row', async () => {
    const { partnerA, orgA1 } = await setup();
    const id = await seedRow({ partnerId: partnerA.id, passwordMode: 'sso_only' });
    const withPartner = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.select().from(portalAccessPolicies).where(eq(portalAccessPolicies.id, id)));
    expect(withPartner).toHaveLength(1);
    // A portal/org-token context carries currentPartnerId NULL (plan D7): the
    // org-member SELECT branch is what makes this visible.
    const noPartner = await withDbAccessContext(orgContext(orgA1.id, null), () =>
      db.select().from(portalAccessPolicies).where(eq(portalAccessPolicies.id, id)));
    expect(noPartner).toHaveLength(1);
  });

  it('portalOrgDbAccessContext(orgA) sees partner P default but not partner Q default', async () => {
    const { partnerA, partnerB, orgA1 } = await setup();
    const pId = await seedRow({ partnerId: partnerA.id });
    const qId = await seedRow({ partnerId: partnerB.id });
    const seen = await withDbAccessContext(portalOrgDbAccessContext(orgA1.id), () =>
      db.select({ id: portalAccessPolicies.id }).from(portalAccessPolicies)
        .where(inArray(portalAccessPolicies.id, [pId, qId])));
    expect(seen.map((r) => r.id)).toEqual([pId]);
  });

  it('portalOrgDbAccessContext cannot UPDATE or DELETE the partner default row (0 rows)', async () => {
    const { partnerA, orgA1 } = await setup();
    const id = await seedRow({ partnerId: partnerA.id, passwordMode: 'allowed' });
    const ctx = portalOrgDbAccessContext(orgA1.id);
    const updated = await withDbAccessContext(ctx, () =>
      db.update(portalAccessPolicies).set({ passwordMode: 'sso_only' })
        .where(eq(portalAccessPolicies.id, id)).returning());
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(ctx, () =>
      db.delete(portalAccessPolicies).where(eq(portalAccessPolicies.id, id)).returning());
    expect(deleted).toHaveLength(0);
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ m: portalAccessPolicies.passwordMode }).from(portalAccessPolicies)
        .where(eq(portalAccessPolicies.id, id)));
    expect(row!.m).toBe('allowed');
  });

  it("org-scoped context cannot see another org's override row", async () => {
    const { partnerA, orgA1, orgA2 } = await setup();
    const id = await seedRow({ orgId: orgA2.id, passwordMode: 'sso_only' });
    const seen = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.select().from(portalAccessPolicies).where(eq(portalAccessPolicies.id, id)));
    expect(seen).toHaveLength(0);
    const seenPortal = await withDbAccessContext(portalOrgDbAccessContext(orgA1.id), () =>
      db.select().from(portalAccessPolicies).where(eq(portalAccessPolicies.id, id)));
    expect(seenPortal).toHaveLength(0);
  });
});
