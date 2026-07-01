/**
 * software_policies RLS — dual-axis (org OR partner) enforcement (#2126, epic #2135).
 *
 * Migration under test: 2026-07-01-software-policies-partner-ownership.sql.
 *
 * A software policy is owned by EITHER an org (org_id set, partner_id NULL —
 * the original shape) OR a partner (partner_id set, org_id NULL — the
 * "partner-wide / all orgs" template shape). The dual-axis policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * Same blindspot as configuration_policies: the rls-coverage contract test does
 * NOT prove the partner branch (it accepts an org-only policy), so this
 * functional test through the REAL postgres.js driver (breeze_app role) is the
 * required guard that a partner cannot forge a partner_id for another partner.
 *
 * software_policy_audit is dual-owned but NOT XOR (a device event under a
 * partner-wide policy carries both axes); its CHECK requires at least one axis.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { softwarePolicies, softwarePolicyAudit } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const createdPolicies: string[] = [];
const createdAudit: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdPolicies.length === 0 && createdAudit.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdAudit) {
      await db.delete(softwarePolicyAudit).where(eq(softwarePolicyAudit.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(softwarePolicies).where(eq(softwarePolicies.id, id));
    }
  });
  createdPolicies.length = 0;
  createdAudit.length = 0;
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
  name: 'Partner-wide blocklist',
  mode: 'blocklist' as const,
  rules: { software: [{ name: 'BitTorrent' }] },
};

async function seedPartnerPolicy(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(softwarePolicies)
      .values({ ...BASE_POLICY, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdPolicies.push(id);
  return id;
}

describe('software_policies RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide software policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(softwarePolicies)
        .values({ ...BASE_POLICY, orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdPolicies.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide software policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: softwarePolicies.id })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a software policy attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: softwarePolicies.id })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge. Drizzle wraps the driver error,
    // so the RLS signal is Postgres code 42501 on the cause.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(softwarePolicies)
          .values({ ...BASE_POLICY, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped software policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(softwarePolicies)
        .values({ ...BASE_POLICY, name: 'Org policy', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdPolicies.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: softwarePolicies.id })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('an org-scope caller cannot see a partner-wide software policy owned by its partner', async () => {
    // Org scope is intentionally narrower: partner-wide templates belong to the
    // partner axis, which org-scope tokens don't hold. Devices still receive
    // the policy via config-policy resolution (system context), and compliance
    // rows are visible per-device — only the template itself is partner-side.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: softwarePolicies.id })
        .from(softwarePolicies)
        .where(eq(softwarePolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects a policy row that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(softwarePolicies)
          .values({ ...BASE_POLICY, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(softwarePolicies)
          .values({ ...BASE_POLICY, name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and soft-DELETE its own partner-wide software policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(softwarePolicies)
        .set({ name: 'Renamed template' })
        .where(eq(softwarePolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed template');

    const deactivated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(softwarePolicies)
        .set({ isActive: false })
        .where(eq(softwarePolicies.id, id))
        .returning(),
    );
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0]?.isActive).toBe(false);
  });
});

describe('software_policy_audit RLS — dual-owned, at-least-one-axis (2026-07-01 migration)', () => {
  it('a dual-owned audit row (device org + policy partner) is visible to BOTH the org and the partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const policyId = await seedPartnerPolicy(partner.id);

    // System (worker) writes the dual-owned row, as the compliance worker does.
    const [audit] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(softwarePolicyAudit)
        .values({
          orgId: org.id,
          partnerId: partner.id,
          policyId,
          action: 'violation_detected',
          actor: 'system',
        })
        .returning(),
    );
    expect(audit).toBeTruthy();
    createdAudit.push(audit!.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: softwarePolicyAudit.id }).from(softwarePolicyAudit).where(eq(softwarePolicyAudit.id, audit!.id)),
    );
    expect(visibleToOrg).toHaveLength(1);

    const visibleToPartner = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.select({ id: softwarePolicyAudit.id }).from(softwarePolicyAudit).where(eq(softwarePolicyAudit.id, audit!.id)),
    );
    expect(visibleToPartner).toHaveLength(1);
  });

  it('the owner CHECK rejects an audit row with NEITHER axis set', async () => {
    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(softwarePolicyAudit)
          .values({ orgId: null, partnerId: null, action: 'policy_created', actor: 'system' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a different partner cannot see a partner-owned audit row', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const policyId = await seedPartnerPolicy(partnerA.id);

    const [audit] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(softwarePolicyAudit)
        .values({ orgId: null, partnerId: partnerA.id, policyId, action: 'policy_created', actor: 'system' })
        .returning(),
    );
    createdAudit.push(audit!.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: softwarePolicyAudit.id }).from(softwarePolicyAudit).where(eq(softwarePolicyAudit.id, audit!.id)),
    );
    expect(visibleToB).toEqual([]);
  });
});
