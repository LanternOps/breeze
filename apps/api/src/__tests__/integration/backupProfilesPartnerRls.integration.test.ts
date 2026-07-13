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
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupProfiles,
  backupConfigs,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyBackupSettings,
  configPolicyAssignments,
  devices,
  sites,
} from '../../db/schema';
import { resolveAllBackupAssignedDevices } from '../../services/featureConfigResolver';
import { createOrganization, createPartner } from './db-utils';

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
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdPolicies) {
      // feature links + settings + assignments cascade from the policy
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
    for (const id of createdProfiles) {
      await db.delete(backupProfiles).where(eq(backupProfiles.id, id));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
    for (const id of createdConfigs) {
      await db.delete(backupConfigs).where(eq(backupConfigs.id, id));
    }
  });
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
      return { policy: policy!, link: link! };
    });
  }

  it('a partner-owned settings row (org_id NULL) is visible to its partner but not another partner, and the XOR CHECK holds', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const profileId = await seedPartnerProfile(partnerA.id);
    const { link } = await seedPartnerPolicyWithLink(partnerA.id, profileId);

    const [settings] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(configPolicyBackupSettings)
        .values({
          featureLinkId: link.id,
          orgId: null,
          partnerId: partnerA.id,
          schedule: { frequency: 'daily', time: '03:00' },
          retention: { preset: 'standard' },
          backupProfileId: profileId,
        })
        .returning(),
    );
    expect(settings).toBeTruthy();

    const visibleToA = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .select({ id: configPolicyBackupSettings.id })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.id, settings!.id)),
    );
    expect(visibleToA).toHaveLength(1);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: configPolicyBackupSettings.id })
        .from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.id, settings!.id)),
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
    const { policy, link } = await seedPartnerPolicyWithLink(partner.id, profileId);

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

      // Settings row mirroring the partner axis, no explicit destination
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link.id,
        orgId: null,
        partnerId: partner.id,
        schedule: { frequency: 'daily', time: '03:00' },
        retention: { preset: 'standard' },
        backupProfileId: profileId,
      });

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
    const { policy, link } = await seedPartnerPolicyWithLink(partner.id, profileId);

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

      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link.id,
        orgId: null,
        partnerId: partner.id,
        schedule: { frequency: 'daily', time: '03:00' },
        retention: { preset: 'standard' },
        backupProfileId: profileId,
      });
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
});
