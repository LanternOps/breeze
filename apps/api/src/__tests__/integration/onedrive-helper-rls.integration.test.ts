/**
 * Real-driver cross-tenant forge tests for config_policy_onedrive_settings (Task 3).
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually
 * enforced.  If `.env.test` is missing the symlink that pins this to the
 * breeze_app role, the positive control in case (b) would still insert (no
 * RLS block on own-org rows), but a BYPASSRLS admin connection would allow
 * the cross-org insert in case (c) — which is why we include a non-vacuity
 * guard (case 0) and a positive control (case b) in addition to the forge
 * case (case c).
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS — see "why no memoization" below):
 *   partnerA → orgA → configPolicyA → featureLinkA
 *   partnerB → orgB → configPolicyB → featureLinkB
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, which
 * cascades through the configuration_policies and config_policy_feature_links
 * FKs and wipes all fixture rows. A module-level fixture cache would hand
 * later tests rows that no longer exist, making the RLS assertions vacuous
 * (a forged insert can surface an incidental FK 23503 instead of 42501).
 * Each it() re-seeds fresh — matching every sibling *-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
  onedriveDeviceState,
  configurationPolicies,
  configPolicyFeatureLinks,
  devices,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  featureLinkA: { id: string };
  featureLinkB: { id: string };
  /** breeze_app context scoped to org A (mirrors authMiddleware org scope). */
  orgAContext: DbAccessContext;
}

// Re-seeds fresh on every call. Intentionally NOT memoized: setup.ts's
// beforeEach cleanupDatabase() TRUNCATEs partners/organizations CASCADE before
// each test, so any cached rows would already be deleted by the time an
// assertion runs — which would silently make every cross-tenant case vacuous.
async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // Seed a configuration policy + feature link for org A.
    const [configPolicyA] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgA.id, name: 'OD Policy A' })
      .returning({ id: configurationPolicies.id });
    if (!configPolicyA) throw new Error('failed to seed config policy A');

    const [featureLinkA] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: configPolicyA.id, featureType: 'onedrive_helper' })
      .returning({ id: configPolicyFeatureLinks.id });
    if (!featureLinkA) throw new Error('failed to seed feature link A');

    // Seed a configuration policy + feature link for org B.
    const [configPolicyB] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgB.id, name: 'OD Policy B' })
      .returning({ id: configurationPolicies.id });
    if (!configPolicyB) throw new Error('failed to seed config policy B');

    const [featureLinkB] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: configPolicyB.id, featureType: 'onedrive_helper' })
      .returning({ id: configPolicyFeatureLinks.id });
    if (!featureLinkB) throw new Error('failed to seed feature link B');

    // Org-scoped breeze_app context for org A.
    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      featureLinkA: { id: featureLinkA.id },
      featureLinkB: { id: featureLinkB.id },
      orgAContext,
    };
  });
}

describe('config_policy_onedrive_settings RLS isolation (breeze_app)', () => {
  // (0) Non-vacuity guard: code-under-test runs as the unprivileged breeze_app
  // role with rolbypassrls=f. If this is ever a BYPASSRLS connection, every
  // assertion below would pass even with broken policies.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.orgAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // (a) Positive control: under org A's context, an org-A settings row for
  // org A's own feature link succeeds. This proves the policy is not
  // deny-everything, which would make the forge case pass for the wrong reason.
  runDb('positive control: org A context can insert its own onedrive settings row', async () => {
    const fx = await seedFixture();

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(configPolicyOnedriveSettings)
        .values({
          featureLinkId: fx.featureLinkA.id,
          orgId: fx.orgA.id,
        })
        .returning({ id: configPolicyOnedriveSettings.id, orgId: configPolicyOnedriveSettings.orgId })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org SELECT hidden: a settings row seeded for org B is invisible
  // to an org A caller. The system-scope probe first confirms the row really
  // exists so the 0-row read under org A is meaningfully "RLS hid it" rather
  // than "it was never seeded" — guarding against a vacuous hidden-row test.
  runDb('hides org B settings from org A SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    // Seed org B's settings row under system scope (RLS-bypassing seed).
    const seededId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({
          featureLinkId: fx.featureLinkB.id,
          orgId: fx.orgB.id,
        })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    // Probe: under system scope the row really exists.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, seededId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under org A breeze_app context the same id returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, seededId))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (c) Cross-org INSERT denied: under an org A context, inserting a settings
  // row carrying org B's feature link + org_id is rejected by the INSERT WITH
  // CHECK policy. Both featureLinkB and orgB are real seeded rows (FKs
  // resolve), so the failure MUST be the RLS 42501, not a 23503 FK violation.
  // Drizzle wraps the driver error: cause.code carries the Postgres SQLSTATE.
  runDb('blocks a forged cross-org config_policy_onedrive_settings INSERT for another org (42501)', async () => {
    const fx = await seedFixture();

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(configPolicyOnedriveSettings).values({
          featureLinkId: fx.featureLinkB.id, // org B's real feature link (FK resolves)
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ---------------------------------------------------------------------------
// config_policy_onedrive_libraries RLS isolation (Task 4)
// ---------------------------------------------------------------------------
// Fixture re-use: seedFixture() is defined above and seeds both orgs, both
// feature links, and an org-A-scoped breeze_app context. Library tests need
// a settings row for the FK reference (settings_id), so each test seeds one
// under system scope before the RLS assertion.
// ---------------------------------------------------------------------------
describe('config_policy_onedrive_libraries RLS isolation (breeze_app)', () => {
  // (a) Positive control: org A can insert a library row for its own settings.
  runDb('positive control: org A context can insert its own library mapping', async () => {
    const fx = await seedFixture();

    // Seed org A's settings row under system scope (FK prerequisite).
    const settingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkA.id, orgId: fx.orgA.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    // Under org A's breeze_app context, inserting a library row for org A succeeds.
    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(configPolicyOnedriveLibraries)
        .values({
          settingsId,
          orgId: fx.orgA.id,
          libraryId: 'lib-a1',
          displayName: 'Org A Documents',
          targetingMode: 'everyone',
        })
        .returning({
          id: configPolicyOnedriveLibraries.id,
          orgId: configPolicyOnedriveLibraries.orgId,
        })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org INSERT denied: org A context cannot insert a library row
  // carrying org B's org_id. The settings_id used is from org B's seeded
  // settings row so the FK resolves — the rejection MUST be RLS (42501),
  // not a FK violation (23503).
  runDb('blocks a forged cross-org config_policy_onedrive_libraries INSERT (42501)', async () => {
    const fx = await seedFixture();

    // Seed org B's settings row under system scope so the FK resolves.
    const orgBSettingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(configPolicyOnedriveLibraries).values({
          settingsId: orgBSettingsId, // org B's real settings row (FK resolves)
          orgId: fx.orgB.id,          // foreign org — RLS WITH CHECK must reject
          libraryId: 'lib-x',
          displayName: 'Finance',
          targetingMode: 'everyone',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ---------------------------------------------------------------------------
// onedrive_device_state RLS isolation (Task 5)
// ---------------------------------------------------------------------------
// This table is device-keyed (PK = device_id) with a denormalized org_id
// (Shape 5). Policies are the same breeze_has_org_access(org_id) form as
// the prior tables, so one row per device and cross-tenant isolation is
// enforced at the org boundary.
//
// Each test seeds its own device (+ site) under system scope to satisfy
// the device_id FK. Fixtures are re-seeded per test (same rationale as
// prior suites — beforeEach cleanupDatabase() TRUNCATE wipes everything).
// ---------------------------------------------------------------------------

let deviceAgentCounter = 0;

/** Insert a device under system scope and return its id. */
async function seedDevice(orgId: string, siteId: string): Promise<string> {
  deviceAgentCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `onedrive-state-test-${deviceAgentCounter}-${Date.now()}`,
      hostname: `host-${deviceAgentCounter}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return row.id;
}

describe('onedrive_device_state RLS isolation (breeze_app)', () => {
  // (a) Positive control: under org A's context, upsert state for org A's
  // own device succeeds and reads back correctly.
  runDb('positive control: org A context can upsert state for its own device', async () => {
    const fx = await seedFixture();

    const { deviceId } = await withSystemDbAccessContext(async () => {
      const siteA = await createSite({ orgId: fx.orgA.id });
      const devId = await seedDevice(fx.orgA.id, siteA.id);
      return { deviceId: devId };
    });

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(onedriveDeviceState)
        .values({
          deviceId,
          orgId: fx.orgA.id,
          signedIn: true,
        })
        .returning({
          deviceId: onedriveDeviceState.deviceId,
          orgId: onedriveDeviceState.orgId,
        })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);
    expect(inserted?.deviceId).toBe(deviceId);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, deviceId))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org SELECT hidden: a state row seeded for org B's device is
  // invisible to an org A caller. System-scope probe first confirms the row
  // really exists so the 0-row read under org A is meaningfully "RLS hid it".
  runDb('hides org B device state from org A SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      const devId = await seedDevice(fx.orgB.id, siteB.id);
      await db
        .insert(onedriveDeviceState)
        .values({ deviceId: devId, orgId: fx.orgB.id, signedIn: false });
      return devId;
    });

    // Probe: under system scope the row really exists.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under org A breeze_app context the same device returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (c) Cross-org INSERT denied: under org A's context, inserting state
  // carrying org B's device_id + org_id is rejected by the INSERT WITH CHECK
  // policy. Both the device row and org row are real (FKs resolve), so the
  // failure MUST be RLS (42501), not a FK violation (23503).
  runDb('blocks a forged cross-org onedrive_device_state INSERT (42501)', async () => {
    const fx = await seedFixture();

    // Seed org B's device under system scope so the FK resolves.
    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      return seedDevice(fx.orgB.id, siteB.id);
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(onedriveDeviceState).values({
          deviceId: orgBDeviceId, // org B's real device (FK resolves)
          orgId: fx.orgB.id,     // foreign org — RLS WITH CHECK must reject
          signedIn: false,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
