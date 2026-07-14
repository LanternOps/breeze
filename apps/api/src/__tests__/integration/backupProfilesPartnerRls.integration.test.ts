/**
 * backup_profiles + config_policy_backup_settings RLS — dual-axis (org OR
 * partner) enforcement (spec 2026-07-13-backup-profiles-design.md).
 *
 * Migration under test: 2026-07-13-backup-profiles.sql.
 *
 * A backup profile ("what to protect" for a device class) is owned by EITHER
 * an org (org_id set, partner_id NULL) OR a partner (partner_id set, org_id
 * NULL — "all orgs"). config_policy_backup_settings mirrors its parent
 * policy's ownership axis (denormalized partner_id, no EXISTS join in RLS).
 *
 * The rls-coverage contract test does NOT prove the partner branch, so this
 * functional test through the REAL postgres.js driver (breeze_app role) is
 * the required guard: cross-partner forge → 42501, XOR violations → 23514,
 * org isolation, and the scheduler fan-out proof (a partner-wide policy's
 * backup link resolves for an org's device with per-selection specs and the
 * org's default destination).
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  backupProfiles,
  backupConfigs,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyBackupSettings,
  configPolicyAssignments,
  devices,
  partnerExportConfigurationOrgState,
  sites,
} from '../../db/schema';
import { resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { updateFeatureLink } from '../../services/configurationPolicy';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const BACKUP_PARITY_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-27-c-backup-feature-settings-parity.sql',
);

const createdProfiles: string[] = [];
const createdConfigs: string[] = [];
const createdPolicies: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  // Each policy delete may acquire owner-specific export-clock locks. Keep
  // unrelated owners in separate transactions so teardown preserves the same
  // lock ordering as the production single-policy delete path.
  for (const id of createdPolicies) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, id)));
  }
  for (const id of createdProfiles) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(backupProfiles).where(eq(backupProfiles.id, id)));
  }
  for (const id of createdDevices) {
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(devices).where(eq(devices.id, id)));
  }
  for (const id of createdSites) {
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(sites).where(eq(sites.id, id)));
  }
  for (const id of createdConfigs) {
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(backupConfigs).where(eq(backupConfigs.id, id)));
  }
  createdPolicies.length = 0;
  createdProfiles.length = 0;
  createdDevices.length = 0;
  createdSites.length = 0;
  createdConfigs.length = 0;
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

const SERVER_SELECTIONS = {
  file: { enabled: true, paths: ['C:\\Users'], excludes: ['*.tmp'] },
  system_image: { enabled: true, includeSystemState: true },
  mssql: { enabled: true, backupType: 'full', excludeDatabases: ['tempdb'] },
};

async function seedPartnerProfile(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(backupProfiles)
      .values({ name: 'Server', orgId: null, partnerId, selections: SERVER_SELECTIONS })
      .returning(),
  );
  const id = rows[0]!.id;
  createdProfiles.push(id);
  return id;
}

describe('backup_profiles RLS — dual-axis (2026-07-13 migration)', () => {
  it('partner scope can INSERT and SELECT back a partner-wide profile', async () => {
    const partner = await createPartner();
    const id = await seedPartnerProfile(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.select({ id: backupProfiles.id }).from(backupProfiles).where(eq(backupProfiles.id, id)),
    );
    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a profile attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerProfile(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: backupProfiles.id }).from(backupProfiles).where(eq(backupProfiles.id, id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(backupProfiles)
          .values({ name: 'Forged', orgId: null, partnerId: partnerA.id, selections: SERVER_SELECTIONS })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT/SELECT an org profile but cannot see a partner-wide one', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerProfileId = await seedPartnerProfile(partner.id);

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(backupProfiles)
        .values({ name: 'Org profile', orgId: org.id, partnerId: null, selections: SERVER_SELECTIONS })
        .returning(),
    );
    if (inserted[0]) createdProfiles.push(inserted[0].id);
    expect(inserted).toHaveLength(1);

    // RLS is stricter than the app layer: org tokens never pass
    // breeze_has_partner_access even though they carry a partnerId.
    const partnerVisibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: backupProfiles.id }).from(backupProfiles).where(eq(backupProfiles.id, partnerProfileId)),
    );
    expect(partnerVisibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects BOTH axes and NEITHER axis', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(backupProfiles)
          .values({ name: 'Both', orgId: org.id, partnerId: partner.id, selections: SERVER_SELECTIONS })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(backupProfiles)
          .values({ name: 'Neither', orgId: null, partnerId: null, selections: SERVER_SELECTIONS })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('config_policy_backup_settings RLS — dual-axis mirror of the parent policy', () => {
  async function seedPartnerPolicyWithLink(partnerId: string, profileId: string) {
    return withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ name: 'Partner backup policy', orgId: null, partnerId, status: 'active' })
        .returning();
      createdPolicies.push(policy!.id);
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: policy!.id, featureType: 'backup', featurePolicyId: profileId })
        .returning();
      const [settings] = await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link!.id, orgId: null, partnerId,
        schedule: { frequency: 'daily', time: '03:00' },
        retention: { preset: 'standard' }, backupProfileId: profileId,
      }).returning();
      return { policy: policy!, link: link!, settings: settings! };
    });
  }

  async function seedOrgPolicyWithLink(orgId: string) {
    return withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db.insert(configurationPolicies).values({
        name: 'Org backup policy', orgId, partnerId: null, status: 'active',
      }).returning();
      createdPolicies.push(policy!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: 'backup', inlineSettings: {},
      }).returning();
      return { policy: policy!, link: link! };
    });
  }

  async function configurationClock(orgId: string): Promise<Date> {
    const rows = await withDbAccessContext(SYSTEM_CTX, () => db.select({
      updatedAt: partnerExportConfigurationOrgState.updatedAt,
    }).from(partnerExportConfigurationOrgState).where(and(
      eq(partnerExportConfigurationOrgState.orgId, orgId),
      eq(partnerExportConfigurationOrgState.resource, 'configuration-policies'),
    )));
    if (!rows[0]) throw new Error('missing configuration policy clock');
    return rows[0].updatedAt;
  }

  it('rejects an org policy feature link to another partner\'s backup profile or destination without advancing its clock', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const [profileB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Partner B profile', orgId: null, partnerId: partnerB.id, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profileB!.id);
    const [destinationB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgB.id, name: 'Partner B destination', type: 'file', provider: 's3', providerConfig: {},
    }).returning());
    createdConfigs.push(destinationB!.id);

    for (const featurePolicyId of [profileB!.id, destinationB!.id]) {
      const [policyA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
        name: 'Partner A reference isolation', orgId: orgA.id, partnerId: null, status: 'active',
      }).returning());
      createdPolicies.push(policyA!.id);
      const before = await configurationClock(orgA.id);

      await expect(withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
        db.insert(configPolicyFeatureLinks).values({
          configPolicyId: policyA!.id, featureType: 'backup', featurePolicyId,
        }).returning(),
      )).rejects.toMatchObject({ cause: { code: '23503' } });
      expect(await configurationClock(orgA.id)).toEqual(before);
    }

    const [profileA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Partner A profile', orgId: orgA.id, partnerId: null, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profileA!.id);
    const [policyA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
      name: 'Partner A update isolation', orgId: orgA.id, partnerId: null, status: 'active',
    }).returning());
    createdPolicies.push(policyA!.id);
    const [validLink] = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), async () => {
      const links = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyA!.id, featureType: 'backup', featurePolicyId: profileA!.id,
      }).returning();
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: links[0]!.id, orgId: orgA.id, partnerId: null,
        schedule: {}, retention: {}, backupProfileId: profileA!.id,
      });
      return links;
    });
    const beforeUpdate = await configurationClock(orgA.id);

    await expect(withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
      db.update(configPolicyFeatureLinks)
        .set({ featurePolicyId: profileB!.id })
        .where(eq(configPolicyFeatureLinks.id, validLink!.id))
        .returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await configurationClock(orgA.id)).toEqual(beforeUpdate);
  });

  it('rejects a same-partner cross-org backup profile reference on an org policy', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [profileB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Org B profile link target', orgId: orgB.id, partnerId: null, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profileB!.id);
    const [policyA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
      name: 'Org A profile isolation', orgId: orgA.id, partnerId: null, status: 'active',
    }).returning());
    createdPolicies.push(policyA!.id);

    await expect(withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyA!.id, featureType: 'backup', featurePolicyId: profileB!.id,
      }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('allows only the same-partner profile reference on a partner policy', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const profileId = await seedPartnerProfile(partner.id);
    const [orgProfile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Org-only profile', orgId: org.id, partnerId: null, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(orgProfile!.id);
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: org.id, name: 'Org-only destination', type: 'file', provider: 's3', providerConfig: {},
    }).returning());
    createdConfigs.push(destination!.id);

    for (const [featurePolicyId, accepted] of [
      [profileId, true],
      [orgProfile!.id, false],
      [destination!.id, false],
    ] as const) {
      const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
        name: `Partner reference ${featurePolicyId}`, orgId: null, partnerId: partner.id, status: 'active',
      }).returning());
      createdPolicies.push(policy!.id);
      const operation = withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
        const links = await db.insert(configPolicyFeatureLinks).values({
          configPolicyId: policy!.id, featureType: 'backup', featurePolicyId,
        }).returning();
        if (accepted) {
          await db.insert(configPolicyBackupSettings).values({
            featureLinkId: links[0]!.id, orgId: null, partnerId: partner.id,
            schedule: {}, retention: {}, backupProfileId: featurePolicyId,
          });
        }
        return links;
      });
      if (accepted) await expect(operation).resolves.toHaveLength(1);
      else await expect(operation).rejects.toMatchObject({ cause: { code: '23503' } });
    }
  });

  it('reverse-validates referenced backup owners for profile parity and legacy fallback links', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const [profile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Reverse link profile', orgId: orgA.id, partnerId: null, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profile!.id);
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgA.id, name: 'Reverse link destination', type: 'file', provider: 's3', providerConfig: {},
    }).returning());
    createdConfigs.push(destination!.id);

    const profileLink = await seedOrgPolicyWithLink(orgA.id);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(configPolicyFeatureLinks)
        .set({ featurePolicyId: profile!.id })
        .where(eq(configPolicyFeatureLinks.id, profileLink.link.id));
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: profileLink.link.id, orgId: orgA.id, partnerId: null,
        schedule: {}, retention: {}, backupProfileId: profile!.id,
      });
    });
    const destinationLink = await seedOrgPolicyWithLink(orgA.id);
    await withDbAccessContext(SYSTEM_CTX, () => db.update(configPolicyFeatureLinks)
      .set({ featurePolicyId: destination!.id })
      .where(eq(configPolicyFeatureLinks.id, destinationLink.link.id)));

    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(backupProfiles)
      .set({ orgId: orgB.id })
      .where(eq(backupProfiles.id, profile!.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(backupConfigs)
      .set({ orgId: orgB.id })
      .where(eq(backupConfigs.id, destination!.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });

    const [policyB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
      name: 'Reverse link org B policy', orgId: orgB.id, partnerId: null, status: 'active',
    }).returning());
    createdPolicies.push(policyB!.id);
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(configPolicyFeatureLinks)
      .set({ configPolicyId: policyB!.id })
      .where(eq(configPolicyFeatureLinks.id, profileLink.link.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rejects a Partner B settings insert against Partner A feature link without advancing A clock', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const { link: linkA } = await seedOrgPolicyWithLink(orgA.id);
    const before = await configurationClock(orgA.id);

    await expect(withDbAccessContext(partnerContext(partnerB.id, [orgB.id]), () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkA.id, orgId: orgB.id, partnerId: null,
        schedule: {}, retention: {},
      }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await configurationClock(orgA.id)).toEqual(before);
  });

  it('rejects moving a valid Partner B settings row onto Partner A feature link without advancing A clock', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const { link: linkA } = await seedOrgPolicyWithLink(orgA.id);
    const { link: linkB } = await seedOrgPolicyWithLink(orgB.id);
    const [settingsB] = await withDbAccessContext(partnerContext(partnerB.id, [orgB.id]), () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkB.id, orgId: orgB.id, partnerId: null,
        schedule: {}, retention: {},
      }).returning(),
    );
    const before = await configurationClock(orgA.id);

    await expect(withDbAccessContext(partnerContext(partnerB.id, [orgB.id]), () =>
      db.update(configPolicyBackupSettings)
        .set({ featureLinkId: linkA.id })
        .where(eq(configPolicyBackupSettings.id, settingsB!.id))
        .returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await configurationClock(orgA.id)).toEqual(before);
  });

  it('rejects cross-org profile and destination references even within one partner', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { link: linkA } = await seedOrgPolicyWithLink(orgA.id);
    const [profileB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Org B profile', orgId: orgB.id, partnerId: null, selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profileB!.id);
    const [destinationB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgB.id, name: 'Org B destination', type: 'file', provider: 's3', providerConfig: {},
    }).returning());
    createdConfigs.push(destinationB!.id);

    await expect(withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkA.id, orgId: orgA.id, partnerId: null,
        backupProfileId: profileB!.id, schedule: {}, retention: {},
      }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });

    await expect(withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkA.id, orgId: orgA.id, partnerId: null,
        destinationConfigId: destinationB!.id, schedule: {}, retention: {},
      }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('reverse-validates parent, profile, and destination owner changes without advancing the original clock', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [profile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Org A reverse-validation profile', orgId: orgA.id, partnerId: null,
      selections: SERVER_SELECTIONS,
    }).returning());
    createdProfiles.push(profile!.id);
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgA.id, name: 'Org A reverse-validation destination', type: 'file',
      provider: 's3', providerConfig: { bucket: 'reverse-validation' },
    }).returning());
    createdConfigs.push(destination!.id);
    const { policy: policyA, link: linkA } = await seedOrgPolicyWithLink(orgA.id);
    const [policyB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
      name: 'Org B reverse-validation policy', orgId: orgB.id, partnerId: null, status: 'active',
    }).returning());
    if (!policyB) throw new Error('Org B reverse-validation policy insert failed');
    createdPolicies.push(policyB.id);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(configPolicyFeatureLinks)
        .set({ featurePolicyId: profile!.id })
        .where(eq(configPolicyFeatureLinks.id, linkA.id));
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkA.id, orgId: orgA.id, partnerId: null,
        schedule: {}, retention: {}, backupProfileId: profile!.id,
        destinationConfigId: destination!.id,
      });
    });
    const before = await configurationClock(orgA.id);

    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(configPolicyFeatureLinks)
      .set({ configPolicyId: policyB.id })
      .where(eq(configPolicyFeatureLinks.id, linkA.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(configurationPolicies)
      .set({ orgId: orgB.id })
      .where(eq(configurationPolicies.id, policyA.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(backupProfiles)
      .set({ orgId: orgB.id })
      .where(eq(backupProfiles.id, profile!.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(backupConfigs)
      .set({ orgId: orgB.id })
      .where(eq(backupConfigs.id, destination!.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await configurationClock(orgA.id)).toEqual(before);
  });

  it('a partner-owned settings row (org_id NULL) is visible to its partner but not another partner, and the XOR CHECK holds', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const profileId = await seedPartnerProfile(partnerA.id);
    const { link, settings } = await seedPartnerPolicyWithLink(partnerA.id, profileId);
    expect(settings).toBeTruthy();

    const visibleToA = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .select({ id: configPolicyBackupSettings.id })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.id, settings.id)),
    );
    expect(visibleToA).toHaveLength(1);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: configPolicyBackupSettings.id })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.id, settings.id)),
    );
    expect(visibleToB).toEqual([]);

    // XOR: neither axis is rejected (both-axes is exercised on backup_profiles
    // above; the same CHECK shape guards this table).
    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(configPolicyBackupSettings)
          .values({
            featureLinkId: link.id,
            orgId: null,
            partnerId: null,
            schedule: {},
            retention: {},
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('FAN-OUT PROOF: a partner-wide policy resolves for an org device with per-selection specs and the org default destination', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const profileId = await seedPartnerProfile(partner.id);
    const { policy } = await seedPartnerPolicyWithLink(partner.id, profileId);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      // Org default destination
      const [config] = await db
        .insert(backupConfigs)
        .values({
          orgId: org.id,
          name: 'Org default S3',
          type: 'file',
          provider: 's3',
          providerConfig: { bucket: 'b', region: 'us-east-1' },
          isDefault: true,
        })
        .returning();
      createdConfigs.push(config!.id);

      // Partner-level assignment + a device in the org
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'partner',
        targetId: partner.id,
        priority: 100,
      });
      const [site] = await db.insert(sites).values({ orgId: org.id, name: 'HQ' }).returning();
      createdSites.push(site!.id);
      const [device] = await db
        .insert(devices)
        .values({
          orgId: org.id,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname: 'srv-01',
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning();
      createdDevices.push(device!.id);

      const entries = await resolveAllBackupAssignedDevices(org.id);
      const entry = entries.find((e) => e.deviceId === device!.id);
      expect(entry).toBeTruthy();
      // Destination falls back to the org default (partner policies never pin one)
      expect(entry!.configId).toBe(config!.id);
      // Profile selections fan out one spec per enabled source, in order
      expect(entry!.selectionSpecs?.map((s) => s.backupMode)).toEqual([
        'file',
        'system_image',
        'mssql',
      ]);
      expect(entry!.selectionSpecs?.[0]?.targets).toMatchObject({
        paths: ['C:\\Users'],
        excludes: ['*.tmp'],
      });
    });
  });

  // The proof above runs in a SYSTEM context (the scheduler's). Every
  // request-path caller — manual "Back up now", the run-all endpoints, the
  // dashboards — runs in the CALLER's context instead, and an org-scoped token
  // never passes breeze_has_partner_access. Resolving there used to return
  // nothing for a partner-linked device: the manual run then fell through to a
  // legacy single-mode job and the dashboards called the device unprotected.
  // This asserts the resolver sees partner-wide state from an ORG context.
  it('FAN-OUT PROOF (org-scoped caller): a partner-wide policy still resolves under an ORG RLS context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const profileId = await seedPartnerProfile(partner.id);
    const { policy } = await seedPartnerPolicyWithLink(partner.id, profileId);

    const { deviceId, configId } = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [config] = await db
        .insert(backupConfigs)
        .values({
          orgId: org.id,
          name: 'Org default S3',
          type: 'file',
          provider: 's3',
          providerConfig: { bucket: 'b', region: 'us-east-1' },
          isDefault: true,
        })
        .returning();
      createdConfigs.push(config!.id);

      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'partner',
        targetId: partner.id,
        priority: 100,
      });
      const [site] = await db.insert(sites).values({ orgId: org.id, name: 'HQ' }).returning();
      createdSites.push(site!.id);
      const [device] = await db
        .insert(devices)
        .values({
          orgId: org.id,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname: 'srv-02',
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning();
      createdDevices.push(device!.id);
      return { deviceId: device!.id, configId: config!.id };
    });

    // The org token carries NO partner access — exactly what a tech's session
    // looks like. Before the system-context fix this resolved to [].
    const entries = await withDbAccessContext(orgContext(org.id), () =>
      resolveAllBackupAssignedDevices(org.id),
    );

    const entry = entries.find((e) => e.deviceId === deviceId);
    expect(entry).toBeTruthy();
    expect(entry!.configId).toBe(configId);
    expect(entry!.selectionSpecs?.map((s) => s.backupMode)).toEqual([
      'file',
      'system_image',
      'mssql',
    ]);
    expect(entry!.selectionError).toBeNull();
  });

  // A partner-wide policy is visible to EVERY org under the partner, so its
  // assignment can name a target in a different org. Resolving org A must never
  // return org B's devices: the worker runs in a system context (no RLS
  // backstop) and a partner-wide link has no pinned destination, so org B's
  // devices would be backed up into ORG A's storage bucket, with the
  // backup_jobs rows filed under org A for A's admins to see.
  it('CROSS-ORG ISOLATION: an org-level assignment to org B contributes NO devices when resolving org A', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const profileId = await seedPartnerProfile(partner.id);
    const { policy } = await seedPartnerPolicyWithLink(partner.id, profileId);

    const { deviceB } = await withDbAccessContext(SYSTEM_CTX, async () => {
      // Org A has a default destination — the bucket org B's data would land in.
      const [configA] = await db
        .insert(backupConfigs)
        .values({
          orgId: orgA.id,
          name: 'Org A default',
          type: 'file',
          provider: 's3',
          providerConfig: { bucket: 'org-a-bucket', region: 'us-east-1' },
          isDefault: true,
        })
        .returning();
      createdConfigs.push(configA!.id);

      // The partner-wide policy is assigned at ORGANIZATION level to org B only.
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'organization',
        targetId: orgB.id,
        priority: 100,
      });

      const [siteB] = await db.insert(sites).values({ orgId: orgB.id, name: 'B HQ' }).returning();
      createdSites.push(siteB!.id);
      const [device] = await db
        .insert(devices)
        .values({
          orgId: orgB.id,
          siteId: siteB!.id,
          agentId: `agent-${siteB!.id.slice(0, 18)}`,
          hostname: 'orgb-srv',
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning();
      createdDevices.push(device!.id);
      return { deviceB: device!.id };
    });

    // Resolve in a SYSTEM context — the scheduler's. This is the context that
    // makes the bug exploitable (no RLS backstop), and running it here is what
    // keeps the assertion honest: outside a context, RLS would deny the device
    // reads and org A would come back empty for the wrong reason.
    const { entriesForA, entriesForB } = await withDbAccessContext(SYSTEM_CTX, async () => ({
      entriesForA: await resolveAllBackupAssignedDevices(orgA.id),
      entriesForB: await resolveAllBackupAssignedDevices(orgB.id),
    }));

    // Org A: the policy matches (partner-wide) but its assignment targets org B,
    // so it must contribute NO devices — least of all org B's.
    expect(entriesForA.find((e) => e.deviceId === deviceB)).toBeUndefined();
    expect(entriesForA).toEqual([]);

    // Positive control: the same assignment DOES cover org B's own device, so
    // the guard blocks the cross-org bleed without breaking the real fan-out.
    expect(entriesForB.find((e) => e.deviceId === deviceB)).toBeTruthy();
  });
});

describe('backup feature-link / normalized-settings parity', () => {
  async function seedOrgBackupTargets() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configurationPolicies).values({
        name: 'Backup parity policy', orgId: org.id, partnerId: null, status: 'active',
      }).returning());
    const profiles = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(backupProfiles).values([
        { name: 'Backup parity profile A', orgId: org.id, partnerId: null, selections: SERVER_SELECTIONS },
        { name: 'Backup parity profile B', orgId: org.id, partnerId: null, selections: SERVER_SELECTIONS },
      ]).returning());
    const destinations = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(backupConfigs).values([
        { orgId: org.id, name: 'Backup parity destination A', type: 'file', provider: 's3', providerConfig: {} },
        { orgId: org.id, name: 'Backup parity destination B', type: 'file', provider: 's3', providerConfig: {} },
      ]).returning());
    if (!policy || profiles.length !== 2 || destinations.length !== 2) {
      throw new Error('backup parity fixture insert failed');
    }
    createdPolicies.push(policy.id);
    createdProfiles.push(...profiles.map((row) => row.id));
    createdConfigs.push(...destinations.map((row) => row.id));
    return { org, policy, profiles, destinations };
  }

  it('requires a profile link and normalized settings to name the same profile at transaction end', async () => {
    const { org, policy, profiles } = await seedOrgBackupTargets();

    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id, featureType: 'backup', featurePolicyId: profiles[0]!.id,
    }))).rejects.toMatchObject({ code: '23514' });

    const linkId = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id, featureType: 'backup', featurePolicyId: profiles[0]!.id,
      }).returning();
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link!.id, orgId: org.id, partnerId: null,
        backupProfileId: profiles[0]!.id, schedule: {}, retention: {},
      });
      return link!.id;
    });

    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.update(configPolicyBackupSettings)
        .set({ backupProfileId: profiles[1]!.id })
        .where(eq(configPolicyBackupSettings.featureLinkId, linkId))))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('reverse-validates link changes while allowing normalized settings delete/reinsert in one transaction', async () => {
    const { org, policy, profiles } = await seedOrgBackupTargets();
    const linkId = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id, featureType: 'backup', featurePolicyId: profiles[0]!.id,
      }).returning();
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link!.id, orgId: org.id, partnerId: null,
        backupProfileId: profiles[0]!.id, schedule: {}, retention: {},
      });
      return link!.id;
    });

    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.update(configPolicyFeatureLinks)
        .set({ featurePolicyId: profiles[1]!.id })
        .where(eq(configPolicyFeatureLinks.id, linkId))))
      .rejects.toMatchObject({ code: '23514' });

    await withDbAccessContext(SYSTEM_CTX, () =>
      updateFeatureLink(linkId, { featurePolicyId: profiles[1]!.id }));
    const [normalized] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ backupProfileId: configPolicyBackupSettings.backupProfileId })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.featureLinkId, linkId)));
    expect(normalized?.backupProfileId).toBe(profiles[1]!.id);

    await expect(withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.featureLinkId, linkId));
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: linkId, orgId: org.id, partnerId: null,
        backupProfileId: profiles[1]!.id, schedule: {}, retention: {},
      });
    })).resolves.toBeUndefined();
  });

  it('allows NULL and legacy-destination links without settings, and enforces legacy settings parity when present', async () => {
    const { org, policy, destinations } = await seedOrgBackupTargets();
    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id, featureType: 'backup', featurePolicyId: null,
      }))).resolves.toBeDefined();

    const [legacyPolicy] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configurationPolicies).values({
        name: 'Backup legacy parity policy', orgId: org.id, partnerId: null, status: 'active',
      }).returning());
    createdPolicies.push(legacyPolicy!.id);
    const [legacyLink] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: legacyPolicy!.id, featureType: 'backup', featurePolicyId: destinations[0]!.id,
      }).returning());
    expect(legacyLink).toBeTruthy();

    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: legacyLink!.id, orgId: org.id, partnerId: null,
        backupProfileId: null, destinationConfigId: destinations[1]!.id,
        schedule: {}, retention: {},
      }))).rejects.toMatchObject({ code: '23514' });

    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configPolicyBackupSettings).values({
        featureLinkId: legacyLink!.id, orgId: org.id, partnerId: null,
        backupProfileId: null, destinationConfigId: destinations[0]!.id,
        schedule: {}, retention: {},
      }))).resolves.toBeDefined();
  });

  it('migration is idempotent and keeps deferred parity helpers private', async () => {
    const migration = readFileSync(BACKUP_PARITY_MIGRATION_FILE, 'utf8');
    const adminDb = getTestDb();
    await expect(adminDb.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(adminDb.execute(sql.raw(migration))).resolves.toBeDefined();
    await ensureAppRole();
    const [result] = await adminDb.execute<{
      validate: boolean; enforce: boolean; deferredLink: boolean; deferredSettings: boolean;
    }>(sql`
      SELECT
        has_function_privilege('breeze_app', 'public.breeze_backup_feature_settings_parity_is_valid(uuid)', 'EXECUTE') AS validate,
        has_function_privilege('breeze_app', 'public.breeze_enforce_backup_feature_settings_parity()', 'EXECUTE') AS enforce,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger
          WHERE tgname = 'config_policy_feature_links_backup_settings_parity'
            AND tgdeferrable AND tginitdeferred
        ) AS "deferredLink",
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger
          WHERE tgname = 'config_policy_backup_settings_feature_parity'
            AND tgdeferrable AND tginitdeferred
        ) AS "deferredSettings"
    `);
    expect(result).toEqual({
      validate: false, enforce: false, deferredLink: true, deferredSettings: true,
    });
  });
});
