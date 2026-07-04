/**
 * sso_providers RLS — dual-axis (org OR partner) enforcement (#2183).
 *
 * Migration under test: 2026-07-03-sso-partner-axis-login-branding.sql.
 *
 * An sso_providers row is owned by EITHER an org (org_id set, partner_id
 * NULL — the original customer-org SSO shape) OR a partner (partner_id set,
 * org_id NULL — the MSP's own technician login, "partner-axis"). The
 * dual-axis policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * Same blindspot as configuration_policies / software_policies: the
 * rls-coverage contract test's org-tenant auto-discovery already asserts the
 * breeze_has_org_access branch (sso_providers has an org_id column), but it
 * does NOT prove the partner branch — that requires a functional test
 * through the REAL postgres.js driver (breeze_app role), which is what this
 * suite is. See memory: rls_dual_axis_contract_test_blindspot.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ssoProviders } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(ssoProviders).where(eq(ssoProviders.id, id));
      }
    },
  );
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

describe('sso_providers RLS — dual-axis (2026-07-03 migration)', () => {
  it('partner A can INSERT a partner-axis provider (org_id NULL, partner_id set)', async () => {
    const partnerA = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(ssoProviders)
        .values({ partnerId: partnerA.id, orgId: null, name: 'Partner IdP', type: 'oidc', status: 'inactive' })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partnerA.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner B forging partner A\'s partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(ssoProviders)
          .values({ partnerId: partnerA.id, orgId: null, name: 'Forged partner IdP', type: 'oidc', status: 'inactive' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('the one-owner CHECK rejects a row that sets BOTH axes and one that sets NEITHER (23514)', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const systemContext: DbAccessContext = {
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: null,
      userId: null,
    };

    // Both axes set → CHECK violation.
    await expect(
      withDbAccessContext(systemContext, () =>
        db
          .insert(ssoProviders)
          .values({ orgId: orgA.id, partnerId: partnerA.id, name: 'Both axes', type: 'oidc', status: 'inactive' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    // Neither axis set → CHECK violation.
    await expect(
      withDbAccessContext(systemContext, () =>
        db
          .insert(ssoProviders)
          .values({ orgId: null, partnerId: null, name: 'No axis', type: 'oidc', status: 'inactive' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner B cannot SELECT partner A\'s partner-axis provider (visibility isolation)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const inserted = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(ssoProviders)
        .values({ partnerId: partnerA.id, orgId: null, name: 'Partner IdP', type: 'oidc', status: 'inactive' })
        .returning(),
    );
    const id = inserted[0]!.id;
    created.push(id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: ssoProviders.id }).from(ssoProviders).where(eq(ssoProviders.id, id)),
    );
    expect(visibleToB).toEqual([]);
  });

  it('an org-scope caller under partner A cannot see partner A\'s partner-axis provider (org tokens never pass breeze_has_partner_access)', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });

    const inserted = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
      db
        .insert(ssoProviders)
        .values({ partnerId: partnerA.id, orgId: null, name: 'Partner IdP', type: 'oidc', status: 'inactive' })
        .returning(),
    );
    const id = inserted[0]!.id;
    created.push(id);

    const visibleToOrg = await withDbAccessContext(orgContext(orgA.id), () =>
      db.select({ id: ssoProviders.id }).from(ssoProviders).where(eq(ssoProviders.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });
});
