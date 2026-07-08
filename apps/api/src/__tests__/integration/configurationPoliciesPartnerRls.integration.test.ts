/**
 * configuration_policies RLS — dual-axis (org OR partner) enforcement (#1724).
 *
 * Migration under test: 2026-06-27-config-policies-partner-ownership.sql.
 *
 * A configuration policy is owned by EITHER an org (org_id set, partner_id NULL —
 * the original Shape-1 form) OR a partner (partner_id set, org_id NULL —
 * "partner-wide / all orgs"). The dual-axis policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * Same blindspot as client_ai_prompt_templates / custom_field_definitions: the
 * rls-coverage contract test does NOT prove the partner branch (it accepts an
 * org-only policy), so this functional test through the REAL postgres.js driver
 * (breeze_app role) is the required guard that a partner cannot forge a
 * partner_id for another partner.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { configurationPolicies, configPolicyAssignments } from '../../db/schema';
import { listConfigPolicies } from '../../services/configurationPolicy';
import { createOrganization, createPartner } from './db-utils';
import { pgErrorCode } from '../../utils/pgErrors';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
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

async function seedPartnerPolicy(partnerId: string, track = true): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId, name: 'Seed partner-wide policy' })
      .returning(),
  );
  const id = rows[0]!.id;
  if (track) created.push(id);
  return id;
}

describe('configuration_policies RLS — dual-axis (2026-06-27 migration)', () => {
  it('partner scope can INSERT a partner-wide policy (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(configurationPolicies)
        .values({ orgId: null, partnerId: partner.id, name: 'All-orgs baseline' })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: configurationPolicies.id })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a policy attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: configurationPolicies.id })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge. Drizzle wraps the driver error,
    // so the RLS signal is Postgres code 42501 on the cause.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(configurationPolicies)
          .values({ orgId: null, partnerId: partnerA.id, name: 'Forged partner-wide' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped policy (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(configurationPolicies)
        .values({ orgId: org.id, partnerId: null, name: 'Org policy' })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: configurationPolicies.id })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('an org-scope caller cannot see a partner-wide policy owned by its partner', async () => {
    // Org scope is intentionally narrower than partner scope: partner-wide
    // policies belong to the partner axis, which org-scope tokens don't hold.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerPolicy(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: configurationPolicies.id })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects a row that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Both axes set → CHECK violation (23514).
    await expect(
      withDbAccessContext(
        { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
        () =>
          db
            .insert(configurationPolicies)
            .values({ orgId: org.id, partnerId: partner.id, name: 'Both axes' })
            .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    // Neither axis set → CHECK violation (23514).
    await expect(
      withDbAccessContext(
        { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
        () =>
          db
            .insert(configurationPolicies)
            .values({ orgId: null, partnerId: null, name: 'No axis' })
            .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('listConfigPolicies filtered by orgId ALSO returns the partner-wide policies that govern that org (#1724 follow-up)', async () => {
    // A partner admin viewing org X should see both X's own policies AND the
    // partner-wide policies that also apply to X — otherwise the org-filtered
    // list hides policies that genuinely govern the org's devices.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const orgPolicyId = (
      await withDbAccessContext(orgContext(org.id), () =>
        db
          .insert(configurationPolicies)
          .values({ orgId: org.id, partnerId: null, name: 'Org-owned' })
          .returning(),
      )
    )[0]!.id;
    created.push(orgPolicyId);
    const partnerPolicyId = await seedPartnerPolicy(partner.id);

    // Minimal AuthContext surface listConfigPolicies actually reads: orgCondition
    // (single accessible org) + partnerId (partner axis).
    const auth = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [org.id],
      orgCondition: (col: PgColumn): SQL | undefined => eq(col, org.id),
    } as never;

    const result = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      listConfigPolicies(auth, { orgId: org.id }, { page: 1, limit: 50 }),
    );
    const ids = result.data.map((p) => p.id);

    expect(ids).toContain(orgPolicyId); // org-owned still shows
    expect(ids).toContain(partnerPolicyId); // partner-wide ALSO shows (the fix)
  });

  it('a SYSTEM-scope org-filtered list only includes the filtered org\'s partner\'s partner-wide policies', async () => {
    // System scope has no access condition at all, so the org filter itself
    // must bound the org_id IS NULL branch to the filtered org's own partner —
    // a bare `OR org_id IS NULL` would return every partner's partner-wide
    // policies platform-wide.
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const aPolicyId = await seedPartnerPolicy(partnerA.id);
    const bPolicyId = await seedPartnerPolicy(partnerB.id);

    const systemAuth = {
      scope: 'system',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: null,
      orgCondition: (): SQL | undefined => undefined,
    } as never;

    const result = await withDbAccessContext(
      { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
      () => listConfigPolicies(systemAuth, { orgId: orgA.id }, { page: 1, limit: 100 }),
    );
    const ids = result.data.map((p) => p.id);

    expect(ids).toContain(aPolicyId); // orgA's partner's partner-wide policy
    expect(ids).not.toContain(bPolicyId); // unrelated partner's must NOT appear
  });

  it('an org-filtered list does NOT surface another partner\'s partner-wide policy', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const foreignPartnerPolicyId = await seedPartnerPolicy(partnerB.id);

    const authA = {
      scope: 'partner',
      partnerId: partnerA.id,
      orgId: null,
      accessibleOrgIds: [orgA.id],
      orgCondition: (col: PgColumn): SQL | undefined => eq(col, orgA.id),
    } as never;

    const result = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
      listConfigPolicies(authA, { orgId: orgA.id }, { page: 1, limit: 50 }),
    );
    expect(result.data.map((p) => p.id)).not.toContain(foreignPartnerPolicyId);
  });

  it('partner scope can UPDATE and DELETE its own partner-wide policy', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id, false);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(configurationPolicies)
        .set({ name: 'Renamed' })
        .where(eq(configurationPolicies.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed');

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .delete(configurationPolicies)
        .where(eq(configurationPolicies.id, id))
        .returning(),
    );
    expect(deleted).toHaveLength(1);
  });

  it('a different partner UPDATE/DELETE silently match zero rows', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerPolicy(partnerA.id);

    const updatedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .update(configurationPolicies)
        .set({ name: 'Hijacked' })
        .where(eq(configurationPolicies.id, id))
        .returning(),
    );
    expect(updatedByB).toEqual([]);

    const deletedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .delete(configurationPolicies)
        .where(eq(configurationPolicies.id, id))
        .returning(),
    );
    expect(deletedByB).toEqual([]);
  });

  it('stays fail-closed without a DB access context (scope "none")', async () => {
    const partner = await createPartner();
    const id = await seedPartnerPolicy(partner.id);

    const rows = await db
      .select({ id: configurationPolicies.id })
      .from(configurationPolicies)
      .where(eq(configurationPolicies.id, id));

    expect(rows).toEqual([]);
  });

  it('rejects a forged assignment linking another partner\'s policy to an out-of-partner org (#2280, 42501)', async () => {
    // config_policy_assignments_org_isolation gates solely on access to the
    // PARENT policy (config_policy_assignments -> configuration_policies EXISTS
    // check), not on the target_id. So the attack this guards against is a
    // partner with NO access to policyP1 (owned by partnerP1) trying to point an
    // assignment row at it — e.g. to "claim" a partner-wide policy they don't
    // own by assigning it into their own org.
    //
    // Unlike the sibling forge tests above (which insert directly into
    // configuration_policies), this WITH CHECK evaluates a nested EXISTS
    // against configuration_policies itself, another RLS-forced table. The
    // forced failure is isolated in a nested `db.transaction` (postgres.js
    // SAVEPOINT) rather than let it reject the outer withDbAccessContext call
    // directly — the same defense-in-depth pattern proven in
    // dbSavepointErrorIsolation.integration.test.ts (#2189): each
    // `sql.savepoint`/`db.transaction` scope tracks its own uncaughtError, so
    // catching the error on the SAVEPOINT-scoped `tx` here means the outer
    // transaction commits cleanly instead of carrying a raw driver error to
    // its own commit — keeping this isolation-sensitive forge test from ever
    // being able to affect the pooled connection a co-run sibling test picks
    // up next. The RLS assertion itself is unchanged: still a real INSERT
    // through the real breeze_app driver, still required to fail with 42501.
    const partnerP1 = await createPartner();
    const partnerQ = await createPartner();
    const orgQ = await createOrganization({ partnerId: partnerQ.id });
    const policyP1 = await seedPartnerPolicy(partnerP1.id);

    let caught: unknown;
    await withDbAccessContext(partnerContext(partnerQ.id, [orgQ.id]), async () => {
      try {
        await db.transaction((tx) =>
          tx
            .insert(configPolicyAssignments)
            .values({
              configPolicyId: policyP1,
              level: 'organization',
              targetId: orgQ.id,
              priority: 0,
            })
            .returning(),
        );
      } catch (err) {
        caught = err;
      }
    });

    expect(pgErrorCode(caught)).toBe('42501');
  });
});
