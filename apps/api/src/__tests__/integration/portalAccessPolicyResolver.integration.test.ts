/**
 * resolvePortalAccessPolicy against real Postgres as breeze_app under FORCE RLS
 * (portal registration W3 #11380, Task 3; Review Focus 2).
 *
 * Portal sessions and org-scoped tokens run with `currentPartnerId: null`
 * (routes/portal/portalDbContext.ts), so the partner-default SELECT branch
 * (`partner_id = breeze_current_partner_id()`) never matches there. The
 * resolver must still see the partner's default row, through the third
 * SELECT-only branch `portal_access_policies_org_member_select` (plan D7) —
 * otherwise it silently falls back to the built-in defaults.
 *
 * The RLS policy proofs (insert/update denials, cross-partner reads) live in
 * portalAccessPoliciesPartnerRls.integration.test.ts (Task 2).
 */
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { hasDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { clientAiTenantMappings, portalAccessPolicies } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { portalOrgDbAccessContext } from '../../routes/portal/portalDbContext';
import {
  PortalAccessPolicyOrgNotFoundError,
  __testOnly,
  resolvePortalAccessPolicy,
} from '../../services/portalAccessPolicy';

afterEach(() => __testOnly.setCapabilities(null));

type Seed = Partial<typeof portalAccessPolicies.$inferInsert>;

/** Superuser seed: bypasses RLS, like the other policy suites' system-path seeds. */
async function seedPolicy(values: Seed): Promise<void> {
  await getTestDb().insert(portalAccessPolicies).values(values);
}

function orgTokenContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId: null,
  };
}

async function setup() {
  const partnerP = await createPartner();
  const partnerQ = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerP.id });
  const orgB = await createOrganization({ partnerId: partnerP.id });
  const orgQ = await createOrganization({ partnerId: partnerQ.id });
  return { partnerP, partnerQ, orgA, orgB, orgQ };
}

describe('resolvePortalAccessPolicy (real DB)', () => {
  it('resolves the partner default under portalOrgDbAccessContext', async () => {
    const { partnerP, partnerQ, orgA, orgB } = await setup();
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    // W4 (#11381) D2: Microsoft is effective only for an org with a proven Entra tenant.
    await getTestDb().insert(clientAiTenantMappings).values({
      orgId: orgA.id, entraTenantId: randomUUID(), provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    });
    await seedPolicy({ partnerId: partnerP.id, entraEnabled: true, ssoSessionMaxHours: 24, ssoNewPersonMode: 'instant' });
    // Noise the resolver must ignore: another partner's default and a sibling org's override.
    await seedPolicy({ partnerId: partnerQ.id, ssoSessionMaxHours: 99, passwordMode: 'sso_only', entraEnabled: true });
    await seedPolicy({ orgId: orgB.id, ssoSessionMaxHours: 2 });
    await seedPolicy({ orgId: orgA.id, passwordMode: 'sso_only', ssoNewPersonMode: 'invited_only' });

    const policy = await withDbAccessContext(portalOrgDbAccessContext(orgA.id), () => resolvePortalAccessPolicy(orgA.id));
    expect(policy.orgId).toBe(orgA.id);
    expect(policy.partnerId).toBe(partnerP.id);
    expect(policy.effective.entraEnabled).toEqual({ value: true, source: 'partner' });
    expect(policy.effective.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });
    expect(policy.effective.ssoNewPersonMode).toEqual({ value: 'invited_only', source: 'org' });
    expect(policy.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(policy.passwordModeFallback).toBe(false);

    // An org-scoped token context (currentPartnerId null) resolves the same policy.
    const viaToken = await withDbAccessContext(orgTokenContext(orgA.id), () => resolvePortalAccessPolicy(orgA.id));
    expect(viaToken.effective).toEqual(policy.effective);
    expect(viaToken.fingerprint).toBe(policy.fingerprint);

    // Without the capability, the inherited entra is masked and sso_only falls back.
    __testOnly.setCapabilities(null);
    const masked = await withDbAccessContext(portalOrgDbAccessContext(orgA.id), () => resolvePortalAccessPolicy(orgA.id));
    expect(masked.effective.entraEnabled).toEqual({ value: false, source: 'partner' });
    expect(masked.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(masked.passwordModeFallback).toBe(true);
  });

  it('resolves with no context held (opens its own system context)', async () => {
    const { partnerP, orgA } = await setup();
    await seedPolicy({ partnerId: partnerP.id, ssoSessionMaxHours: 48 });
    await seedPolicy({ orgId: orgA.id, ssoNewPersonMode: 'invited_only' });

    expect(hasDbAccessContext()).toBe(false);
    const policy = await resolvePortalAccessPolicy(orgA.id);
    expect(hasDbAccessContext()).toBe(false);
    expect(policy.partnerId).toBe(partnerP.id);
    expect(policy.effective.ssoSessionMaxHours).toEqual({ value: 48, source: 'partner' });
    expect(policy.effective.ssoNewPersonMode).toEqual({ value: 'invited_only', source: 'org' });
    expect(policy.effective.passwordMode).toEqual({ value: 'allowed', source: 'default' });

    // No rows at all: today's behaviour by construction.
    const { orgQ } = await setup();
    const none = await resolvePortalAccessPolicy(orgQ.id);
    expect(none.effective.passwordMode).toEqual({ value: 'allowed', source: 'default' });
    expect(none.effective.entraEnabled).toEqual({ value: false, source: 'default' });
    expect(none.passwordModeFallback).toBe(false);
  });

  it('throws PortalAccessPolicyOrgNotFoundError for an unknown org id', async () => {
    const { orgA, orgQ } = await setup();
    const unknown = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
    await expect(resolvePortalAccessPolicy(unknown)).rejects.toBeInstanceOf(PortalAccessPolicyOrgNotFoundError);

    // Under a held context, an org the context cannot see reads as not found, and the
    // throw (an app error, not a SQL failure) leaves the held transaction usable.
    const after = await withDbAccessContext(portalOrgDbAccessContext(orgA.id), async () => {
      await expect(resolvePortalAccessPolicy(orgQ.id)).rejects.toBeInstanceOf(PortalAccessPolicyOrgNotFoundError);
      return resolvePortalAccessPolicy(orgA.id);
    });
    expect(after.orgId).toBe(orgA.id);
  });
});
