/**
 * portal_access_policies RLS: dual-axis (org XOR partner) enforcement against
 * real Postgres as breeze_app under FORCE RLS (W3 #11380, plan Task 2).
 * Template: ticketApprovalSettingsPartnerRls.integration.test.ts.
 *
 * Policies (2027-01-22-232800-portal-access-policies-requests.sql):
 *   portal_access_policies_tenant                    FOR ALL
 *   portal_access_policies_partner_default_select    FOR SELECT (current partner)
 *   portal_access_policies_org_member_select         FOR SELECT (any org of the partner)
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { clientAiTenantMappings, portalAccessPolicies } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { portalOrgDbAccessContext } from '../../routes/portal/portalDbContext';
import { __testOnly, resolvePortalAccessPolicy } from '../../services/portalAccessPolicy';
import { getOrgPortalAccessPolicyView, updateOrgPortalAccessPolicy } from '../../services/portalAccessPolicyWrites';
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

/**
 * W4 (#11381) D2: the resolver masks Microsoft by the org's PROVEN tenant, read
 * through a LEFT JOIN on its organizations read, under whatever context it runs.
 * client_ai_tenant_mappings is shape-1 RLS (breeze_has_org_access(org_id)).
 */
describe('portal access policy tenant proof under RLS (W4)', () => {
  const ENTRA_CAPS = { entra: true, google: false, selfRegistration: false };
  const PROVEN_AT = new Date('2027-01-23T10:00:00.000Z');

  afterEach(() => __testOnly.setCapabilities(null));

  async function seedMapping(orgId: string, proven: boolean): Promise<string> {
    const tenantId = randomUUID();
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(clientAiTenantMappings).values({
        orgId,
        entraTenantId: tenantId,
        ...(proven
          ? { provenAt: PROVEN_AT, provenVia: 'proof_run' as const, provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() } }
          : {}),
      }));
    return tenantId;
  }

  async function seedPartnerEntraOn(partnerId: string): Promise<void> {
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(portalAccessPolicies).values({ partnerId, entraEnabled: true }).returning({ id: portalAccessPolicies.id }));
    createdRowIds.push(row!.id);
  }

  it('resolves entraTenant under portalOrgDbAccessContext and with no context held', async () => {
    const { partnerA, orgA1, orgA2 } = await setup();
    __testOnly.setCapabilities(ENTRA_CAPS);
    await seedPartnerEntraOn(partnerA.id);
    const tenantA1 = await seedMapping(orgA1.id, true);
    await seedMapping(orgA2.id, false);

    const viaPortal = await withDbAccessContext(portalOrgDbAccessContext(orgA1.id), () => resolvePortalAccessPolicy(orgA1.id));
    expect(viaPortal.entraTenant).toEqual({ tenantId: tenantA1, provenAt: PROVEN_AT.toISOString() });
    expect(viaPortal.effective.entraEnabled).toEqual({ value: true, source: 'partner' });

    expect(hasDbAccessContext()).toBe(false);
    const noContext = await resolvePortalAccessPolicy(orgA1.id);
    expect(hasDbAccessContext()).toBe(false);
    expect(noContext.entraTenant).toEqual(viaPortal.entraTenant);
    expect(noContext.fingerprint).toBe(viaPortal.fingerprint);

    // A mapping without a proof is not a tenant: Microsoft stays masked (inv. 2).
    const unproven = await withDbAccessContext(portalOrgDbAccessContext(orgA2.id), () => resolvePortalAccessPolicy(orgA2.id));
    expect(unproven.entraTenant).toBeNull();
    expect(unproven.effective.entraEnabled).toEqual({ value: false, source: 'partner' });

    // Repointing the tenant clears the proof (inv. 3 trigger): the next resolve masks Microsoft.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(clientAiTenantMappings).set({ entraTenantId: randomUUID() }).where(eq(clientAiTenantMappings.orgId, orgA1.id)));
    const repointed = await withDbAccessContext(portalOrgDbAccessContext(orgA1.id), () => resolvePortalAccessPolicy(orgA1.id));
    expect(repointed.entraTenant).toBeNull();
    expect(repointed.effective.entraEnabled).toEqual({ value: false, source: 'partner' });
    expect(repointed.fingerprint).not.toBe(viaPortal.fingerprint);
  });

  it('the org view and the org write read the proven tenant under a partner request context', async () => {
    const { partnerA, orgA1, orgA2 } = await setup();
    __testOnly.setCapabilities(ENTRA_CAPS);
    await seedMapping(orgA1.id, true);
    const ctx = partnerContext(partnerA.id, [orgA1.id, orgA2.id]);
    const orgA1Ref = { id: orgA1.id, partnerId: partnerA.id };
    const orgA2Ref = { id: orgA2.id, partnerId: partnerA.id };

    expect((await withDbAccessContext(ctx, () => getOrgPortalAccessPolicyView(orgA1Ref))).entraTenantProven).toBe(true);
    expect((await withDbAccessContext(ctx, () => getOrgPortalAccessPolicyView(orgA2Ref))).entraTenantProven).toBe(false);

    await expect(withDbAccessContext(ctx, () => updateOrgPortalAccessPolicy(orgA2Ref, { entraEnabled: true })))
      .rejects.toMatchObject({ code: 'PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN', field: 'entraEnabled' });

    const saved = await withDbAccessContext(ctx, () => updateOrgPortalAccessPolicy(orgA1Ref, { entraEnabled: true }));
    expect(saved.changedFields).toEqual(['entraEnabled']);
    expect(saved.view.effective.entraEnabled).toEqual({ value: true, source: 'org' });
    expect(saved.view.entraTenantProven).toBe(true);
  });
});
