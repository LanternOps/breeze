/**
 * Real-driver cross-tenant forge tests for config_policy_remote_access_settings
 * (remote-session consent settings — migration 2026-06-19).
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually enforced.
 * If `.env.test` is missing the symlink that pins this to the breeze_app role,
 * these tests would pass vacuously on a BYPASSRLS admin connection (see memory:
 * worktree_env_test_rls_vacuous) — the forged-insert assertion (case b) is the
 * guard that catches that.
 *
 * Why this table needs a FUNCTIONAL forge test, not just the rls-coverage
 * contract allowlist: the settings table is FK-child (shape 5). Its policies
 * reach org through a NESTED scalar subquery inside EXISTS:
 *   feature_link_id → config_policy_feature_links.config_policy_id
 *                   → configuration_policies.org_id → breeze_has_org_access(...)
 * That is exactly the #1016 (rls_nested_exists_bound_param_bug) construct that
 * silently failed under postgres.js bound params — passing in psql, denying
 * EVERYTHING (incl. same-tenant) under the app driver. The rls-coverage contract
 * test only proves the policy EXISTS; only the cases below prove it ISOLATES
 * cross-tenant (a/b/c) AND does not vacuously deny same-tenant (d, the #1016
 * guard).
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS — see the catalog-rls "why no memoization" note):
 *   partnerA → orgA → policyA1 → linkA1 (remote_access) → settingsA1
 *                   → policyA2 → linkA2 (remote_access, NO settings row yet)
 *   partnerB → orgB
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyRemoteAccessSettings,
  organizations,
  partners,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const seededPartnerIds: string[] = [];

interface Fixture {
  orgA: { id: string };
  linkA1: { id: string };
  linkA2: { id: string };
  settingsA1: { id: string };
  orgAContext: DbAccessContext;
  orgBContext: DbAccessContext;
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

function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

// Re-seeds fresh on every call. Intentionally NOT memoized: setup.ts's
// beforeEach cleanupDatabase() TRUNCATEs partners/organizations CASCADE before
// each test, so cached rows would be gone by assertion time (vacuous reads).
async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    seededPartnerIds.push(partnerA.id, partnerB.id);

    // policyA1 + a remote_access link carrying a settings row (read/update/delete
    // isolation cases).
    const [policyA1] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgA.id, name: 'RAS Policy A1', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [linkA1] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyA1!.id, featureType: 'remote_access', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    const [settingsA1] = await db
      .insert(configPolicyRemoteAccessSettings)
      .values({
        featureLinkId: linkA1!.id,
        sessionPromptMode: 'consent',
        consentUnavailableBehavior: 'block',
        technicianIdentityLevel: 'name',
      })
      .returning({ id: configPolicyRemoteAccessSettings.id });

    // policyA2 + a remote_access link with NO settings row yet — its id is used
    // as the FK target for the same-tenant happy-path insert (case d) and the
    // cross-tenant forged insert (case b). The link exists (FK resolves), so the
    // only reason an insert can fail is the RLS WITH CHECK — never an incidental
    // 23503. feature_link_id is UNIQUE, so each case needs its own fresh link;
    // the per-test re-seed gives every it() a fresh linkA2.
    const [policyA2] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgA.id, name: 'RAS Policy A2', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [linkA2] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyA2!.id, featureType: 'remote_access', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });

    if (!linkA1 || !linkA2 || !settingsA1) throw new Error('failed to seed remote-access settings fixture');

    return {
      orgA: { id: orgA.id },
      linkA1: { id: linkA1.id },
      linkA2: { id: linkA2.id },
      settingsA1: { id: settingsA1.id },
      orgAContext: orgContext(orgA.id),
      orgBContext: orgContext(orgB.id),
    };
  });
}

// Partner-owned fixture topology, for the dual-axis (2026-07-29) cases.
// Fixture topology (seeded fresh per test under system scope):
//   partnerA → orgA
//            → policyFresh (org_id NULL, partner_id partnerA) → linkPartnerFresh (remote_access, no settings)
//            → policyForge (org_id NULL, partner_id partnerA) → linkPartnerForge (remote_access, no settings)
//            → policySeeded (org_id NULL, partner_id partnerA) → linkSeeded (remote_access) → settingsPartnerA
//   partnerB (no orgs needed — only used to forge)
interface PartnerFixture {
  orgA: { id: string };
  linkPartnerFresh: { id: string };
  linkPartnerForge: { id: string };
  settingsPartnerA: { id: string };
  partnerAContext: DbAccessContext;
  partnerBContext: DbAccessContext;
  orgAContext: DbAccessContext;
}

async function seedPartnerFixture(): Promise<PartnerFixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    seededPartnerIds.push(partnerA.id, partnerB.id);

    const [policyFresh] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partnerA.id, name: 'RAS Partner Policy (fresh)', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [linkPartnerFresh] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyFresh!.id, featureType: 'remote_access', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });

    const [policyForge] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partnerA.id, name: 'RAS Partner Policy (forge target)', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [linkPartnerForge] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyForge!.id, featureType: 'remote_access', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });

    const [policySeeded] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partnerA.id, name: 'RAS Partner Policy (pre-seeded)', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [linkSeeded] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policySeeded!.id, featureType: 'remote_access', inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    const [settingsPartnerA] = await db
      .insert(configPolicyRemoteAccessSettings)
      .values({
        featureLinkId: linkSeeded!.id,
        sessionPromptMode: 'consent',
        consentUnavailableBehavior: 'block',
        technicianIdentityLevel: 'name',
      })
      .returning({ id: configPolicyRemoteAccessSettings.id });

    if (!linkPartnerFresh || !linkPartnerForge || !settingsPartnerA) {
      throw new Error('failed to seed partner-owned remote-access settings fixture');
    }

    return {
      orgA: { id: orgA.id },
      linkPartnerFresh: { id: linkPartnerFresh.id },
      linkPartnerForge: { id: linkPartnerForge.id },
      settingsPartnerA: { id: settingsPartnerA.id },
      partnerAContext: partnerContext(partnerA.id, [orgA.id]),
      partnerBContext: partnerContext(partnerB.id, []),
      orgAContext: orgContext(orgA.id),
    };
  });
}

// Best-effort safety net only; setup.ts's beforeEach already wipes core tenant
// tables CASCADE (which cascades through the policy FKs) before every test.
afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  // configuration_policies → feature_links → settings all cascade, so delete
  // policies (for the seeded orgs) before the organizations they reference.
  // Separate transactions: the policy delete takes org-level partner-export
  // locks while the organizations delete takes partner-level locks, and the
  // lock hierarchy forbids partner-after-org within one transaction.
  // Includes partner-owned policies (org_id NULL, partner_id set) — those
  // wouldn't be caught by the org-subselect delete below, and would otherwise
  // FK-block the partner delete that follows.
  await withSystemDbAccessContext(async () => {
    await db
      .delete(configurationPolicies)
      .where(
        sql`${configurationPolicies.orgId} IN (SELECT id FROM organizations WHERE partner_id IN (${partnerList}))
            OR ${configurationPolicies.partnerId} IN (${partnerList})`
      );
  });
  await withSystemDbAccessContext(async () => {
    await db.delete(organizations).where(sql`${organizations.partnerId} IN (${partnerList})`);
    await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
  });
});

describe('config_policy_remote_access_settings RLS isolation (breeze_app)', () => {
  // (a) Cross-org READ isolation: org B cannot see org A's settings row.
  runDb('org B context cannot read an org-A remote-access settings row', async () => {
    const { settingsA1, orgBContext } = await seedFixture();

    const rowsB = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: configPolicyRemoteAccessSettings.id })
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, settingsA1.id))
    );
    expect(rowsB).toHaveLength(0);
  });

  // (b) A forged cross-org INSERT (org B context, FK pointing at org A's link)
  // is rejected by the WITH CHECK policy. linkA2's FK resolves, so the ONLY
  // failure reason is RLS → 42501 (insufficient_privilege), never a 23503 FK
  // error. Drizzle wraps the driver error; the Postgres code rides on `cause`.
  runDb('a forged cross-org settings insert is rejected by RLS', async () => {
    const { linkA2, orgBContext } = await seedFixture();

    await expect(
      withDbAccessContext(orgBContext, () =>
        db.insert(configPolicyRemoteAccessSettings).values({
          featureLinkId: linkA2.id, // org A's link — RLS must reject
          sessionPromptMode: 'consent',
          consentUnavailableBehavior: 'block',
          technicianIdentityLevel: 'generic',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (c) Cross-org WRITE isolation: org B's UPDATE/DELETE targeting org A's
  // settings row matches 0 rows (RLS USING filters it out — no error), and the
  // row survives untouched under system scope.
  runDb('org B context UPDATE/DELETE on an org-A settings row affects 0 rows; row survives', async () => {
    const { settingsA1, orgBContext } = await seedFixture();

    const updated = await withDbAccessContext(orgBContext, () =>
      db
        .update(configPolicyRemoteAccessSettings)
        .set({ sessionPromptMode: 'off' })
        .where(eq(configPolicyRemoteAccessSettings.id, settingsA1.id))
        .returning({ id: configPolicyRemoteAccessSettings.id })
    );
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgBContext, () =>
      db
        .delete(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, settingsA1.id))
        .returning({ id: configPolicyRemoteAccessSettings.id })
    );
    expect(deleted).toHaveLength(0);

    const survivor = await withSystemDbAccessContext(() =>
      db
        .select({ id: configPolicyRemoteAccessSettings.id, mode: configPolicyRemoteAccessSettings.sessionPromptMode })
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, settingsA1.id))
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.mode).toBe('consent'); // seeded value, not the forged 'off'
  });

  // (d) Same-tenant POSITIVE path — the #1016 vacuous-deny guard. Org A can both
  // INSERT a settings row for its OWN feature link and read it back. If the
  // nested-EXISTS policy mis-binds under the app driver (the #1016 failure mode),
  // this insert/read would be denied too, so a green (a/b/c) is not enough.
  runDb('org A context can insert and read its own settings row', async () => {
    const { orgA, linkA2, orgAContext } = await seedFixture();

    const inserted = await withDbAccessContext(orgAContext, () =>
      db
        .insert(configPolicyRemoteAccessSettings)
        .values({
          featureLinkId: linkA2.id, // org A's own link
          sessionPromptMode: 'notify',
          consentUnavailableBehavior: 'proceed',
          technicianIdentityLevel: 'name_email',
        })
        .returning({ id: configPolicyRemoteAccessSettings.id })
    );
    expect(inserted).toHaveLength(1);

    const readBack = await withDbAccessContext(orgAContext, () =>
      db
        .select({ id: configPolicyRemoteAccessSettings.id, mode: configPolicyRemoteAccessSettings.sessionPromptMode })
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, inserted[0]!.id))
    );
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.mode).toBe('notify');
    // The org id is genuinely org A's (sanity on the fixture, not just RLS).
    expect(orgA.id).toBeTruthy();
  });
});

// Dual-axis coverage (2026-07-29-remote-access-settings-partner-rls.sql,
// pre-existing bug 4): the 2026-06-19 policies reached ownership only via
// breeze_has_org_access(cp.org_id). For a partner-owned parent policy
// (org_id NULL, partner_id set — 2026-06-27-config-policies-partner-ownership)
// that branch is always false, so partner-wide consent settings were
// invisible/unwritable to every org- and partner-scoped principal. The read
// path used by agents is unaffected (system context); this is the broken
// UI write/read surface for a technician editing a partner-wide policy.
describe('partner-owned policy consent settings (dual-axis)', () => {
  // Owning-partner write+read: the case the org-only policy fails before the
  // 2026-07-29 migration (breeze_has_org_access(NULL) -> false -> 0 rows /
  // 42501 on insert).
  runDb('partner-scope token of the owning partner can INSERT + SELECT the child row', async () => {
    const { linkPartnerFresh, partnerAContext } = await seedPartnerFixture();

    const inserted = await withDbAccessContext(partnerAContext, () =>
      db
        .insert(configPolicyRemoteAccessSettings)
        .values({
          featureLinkId: linkPartnerFresh.id,
          sessionPromptMode: 'notify',
          consentUnavailableBehavior: 'proceed',
          technicianIdentityLevel: 'name_email',
        })
        .returning({ id: configPolicyRemoteAccessSettings.id })
    );
    expect(inserted).toHaveLength(1);

    const readBack = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: configPolicyRemoteAccessSettings.id, mode: configPolicyRemoteAccessSettings.sessionPromptMode })
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, inserted[0]!.id))
    );
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.mode).toBe('notify');
  });

  // Org tokens never pass breeze_has_partner_access — RLS stays stricter than
  // the app layer. Do not "fix" this by loosening the policy; a partner-wide
  // row is visible only to callers holding partner-axis access.
  runDb('org-scope token in the owning partner CANNOT see partner-wide child rows', async () => {
    const { settingsPartnerA, orgAContext } = await seedPartnerFixture();

    const rows = await withDbAccessContext(orgAContext, () =>
      db
        .select({ id: configPolicyRemoteAccessSettings.id })
        .from(configPolicyRemoteAccessSettings)
        .where(eq(configPolicyRemoteAccessSettings.id, settingsPartnerA.id))
    );
    expect(rows).toHaveLength(0);
  });

  // Cross-partner forge: partnerB has no access grant to partnerA's
  // partner-owned link, so the WITH CHECK must reject with 42501 — never a
  // silent 0-row no-op and never an incidental FK error (the link resolves).
  runDb('cross-partner forge fails with 42501', async () => {
    const { linkPartnerForge, partnerBContext } = await seedPartnerFixture();

    await expect(
      withDbAccessContext(partnerBContext, () =>
        db.insert(configPolicyRemoteAccessSettings).values({
          featureLinkId: linkPartnerForge.id, // partner A's link — RLS must reject
          sessionPromptMode: 'consent',
          consentUnavailableBehavior: 'block',
          technicianIdentityLevel: 'generic',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
