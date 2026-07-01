/**
 * security_policies RLS — dual-axis (org OR partner) enforcement (#2127, epic #2135).
 *
 * Migration under test: 2026-07-01-security-policies-partner-ownership.sql.
 *
 * A security policy is owned by EITHER an org (org_id set, partner_id NULL —
 * the original shape) OR a partner (partner_id set, org_id NULL — the
 * "partner-wide / all orgs" template shape). The dual-axis policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * Same dual-axis blindspot as software_policies/configuration_policies: the
 * rls-coverage contract test does NOT prove the partner branch, so this
 * functional test through the REAL postgres.js driver (breeze_app role) is the
 * required guard that a partner cannot forge a partner_id for another partner.
 * security_policies is a LEAF (no FK children), so there is no audit/child
 * suite here.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { securityPolicies } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of created) {
      await db.delete(securityPolicies).where(eq(securityPolicies.id, id));
    }
  });
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

const BASE_POLICY = {
  name: 'Partner-wide security baseline',
  settings: { scanSchedule: 'daily', realTimeProtection: true },
};

async function seedPartnerPolicy(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(securityPolicies)
      .values({ ...BASE_POLICY, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  created.push(id);
  return id;
}

describe('security_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide security policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(securityPolicies)
        .values({ ...BASE_POLICY, orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide security policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: securityPolicies.id })
        .from(securityPolicies)
        .where(eq(securityPolicies.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a security policy attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: securityPolicies.id })
        .from(securityPolicies)
        .where(eq(securityPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge (Postgres 42501 on the cause).
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(securityPolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped security policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(securityPolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: securityPolicies.id })
        .from(securityPolicies)
        .where(eq(securityPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('an org-scope caller cannot see a partner-wide security policy owned by its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: securityPolicies.id })
        .from(securityPolicies)
        .where(eq(securityPolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects a row that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(securityPolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(securityPolicies)
          .values({ ...BASE_POLICY, name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide security policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(securityPolicies)
        .set({ name: 'Renamed baseline' })
        .where(eq(securityPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed baseline');

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .delete(securityPolicies)
        .where(eq(securityPolicies.id, id))
        .returning(),
    );
    expect(deleted).toHaveLength(1);
    created.splice(created.indexOf(id), 1);
  });
});
