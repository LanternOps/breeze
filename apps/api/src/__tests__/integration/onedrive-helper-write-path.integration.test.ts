/**
 * Integration test: write path — decomposeInlineSettings + deleteNormalizedRows
 * for `onedrive_helper` (Phase 2 Task 3).
 *
 * Verifies that addFeatureLink / updateFeatureLink / removeFeatureLink actually
 * populate (and clean up) the normalized `config_policy_onedrive_settings` /
 * `config_policy_onedrive_libraries` tables — without this, the feature-link
 * JSONB mirror is written but nothing the delivery resolver
 * (buildOnedriveHelperConfigUpdate, see onedrive-helper-config-delivery test)
 * can actually read.
 *
 * All service calls run under withSystemDbAccessContext: addFeatureLink /
 * updateFeatureLink / removeFeatureLink use the bare `db` (breeze_app) pool,
 * same as every other configurationPolicy.ts write path, so they need an
 * access context — system scope is fine here since this test isn't
 * exercising RLS (that's onedrive-helper-rls.integration.test.ts's job).
 *
 * Fixtures are re-seeded per test — setup.ts's cleanupDatabase() TRUNCATEs
 * partners/organizations CASCADE on beforeEach, wiping all policy rows.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
} from '../../db/schema';
import { addFeatureLink, updateFeatureLink, removeFeatureLink } from '../../services/configurationPolicy';
import { createPartner, createOrganization } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface SeedResult {
  orgId: string;
  partnerId: string;
  policyId: string;
}

async function seedOrgPolicy(): Promise<SeedResult> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ name: 'OD Policy', orgId: org.id, status: 'active' })
      .returning({ id: configurationPolicies.id });
    if (!policy) throw new Error('seedOrgPolicy: failed to insert configuration policy');
    return { orgId: org.id, partnerId: partner.id, policyId: policy.id };
  });
}

const SETTINGS = {
  silentAccountConfig: true,
  filesOnDemand: true,
  kfmSilentOptIn: true,
  kfmFolders: ['Documents'],
  kfmBlockOptOut: false,
  tenantAssociationId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
  restartOnChange: true,
  libraries: [
    {
      libraryId: 'tenantId=t&siteId={s1}&webId={w1}&listId={l1}&webUrl=u1&version=1',
      displayName: 'Finance',
      targetingMode: 'graph_group',
      groupId: 'g-fin',
    },
    {
      libraryId: 'tenantId=t&siteId={s2}&webId={w2}&listId={l2}&webUrl=u2&version=1',
      displayName: 'Company',
      targetingMode: 'everyone',
    },
  ],
};

describe('onedrive_helper write path', () => {
  let ctx: SeedResult;
  beforeEach(async () => {
    ctx = await seedOrgPolicy();
  });

  runDb('addFeatureLink decomposes settings + libraries with org_id and sortOrder', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS)
    );
    expect(link).not.toBeNull();

    const [settings] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id))
    );
    expect(settings).toBeDefined();
    expect(settings!.orgId).toBe(ctx.orgId);
    expect(settings!.kfmSilentOptIn).toBe(true);
    expect(settings!.kfmFolders).toEqual(['Documents']);

    const libs = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.settingsId, settings!.id))
        .orderBy(configPolicyOnedriveLibraries.sortOrder)
    );
    expect(libs).toHaveLength(2);
    expect(libs[0]!.displayName).toBe('Finance');
    expect(libs[0]!.sortOrder).toBe(0);
    expect(libs[1]!.sortOrder).toBe(1);
    expect(libs.every((l) => l.orgId === ctx.orgId)).toBe(true);
  });

  runDb('updateFeatureLink replaces the normalized rows', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS)
    );
    await withSystemDbAccessContext(() =>
      updateFeatureLink(
        link!.id,
        { inlineSettings: { ...SETTINGS, kfmSilentOptIn: false, libraries: [SETTINGS.libraries[1]!] } },
        ctx.policyId
      )
    );
    const [settings] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id))
    );
    expect(settings!.kfmSilentOptIn).toBe(false);
    const libs = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.settingsId, settings!.id))
    );
    expect(libs).toHaveLength(1);
    expect(libs[0]!.displayName).toBe('Company');
  });

  runDb('removeFeatureLink cascades settings and libraries away', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS)
    );
    await withSystemDbAccessContext(() => removeFeatureLink(link!.id, ctx.policyId));
    const rows = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('rejects a partner-wide policy', async () => {
    const [pwPolicy] = await withSystemDbAccessContext(() =>
      db
        .insert(configurationPolicies)
        .values({ name: 'PW Policy', orgId: null, partnerId: ctx.partnerId, status: 'active' })
        .returning({ id: configurationPolicies.id })
    );
    await expect(
      withSystemDbAccessContext(() => addFeatureLink(pwPolicy!.id, 'onedrive_helper', null, SETTINGS))
    ).rejects.toThrow(/partner-wide/);
  });

  runDb('rejects invalid inline settings inside the transaction (zod backstop)', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        addFeatureLink(ctx.policyId, 'onedrive_helper', null, {
          libraries: [{ libraryId: 'x', displayName: 'X', targetingMode: 'nonsense' }],
        })
      )
    ).rejects.toThrow();
  });
});
