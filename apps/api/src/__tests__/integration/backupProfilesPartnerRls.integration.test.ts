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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
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
  organizations,
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
const BACKUP_SERIALIZATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-01-b-serialize-backup-policy-references.sql',
);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForRaceSignal<T>(
  signal: Promise<T>,
  worker: Promise<unknown>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} did not report progress within 5 seconds`));
    }, 5_000);
  });
  const workerStopped = worker.then<never>(
    () => {
      throw new Error(`${label} completed before reporting progress`);
    },
    (error: unknown) => {
      throw new Error(`${label} failed before reporting progress`, { cause: error });
    },
  );

  try {
    return await Promise.race([signal, workerStopped, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(
    clients.map((client) => client.end({ timeout: 1 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to close backup race database client(s)');
  }
}

async function waitForBackendLockWait(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await getTestDb().execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE pid = ${backendPid}
          AND state = 'active'
          AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
      ) AS waiting
    `);
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backup relationship mover backend ${backendPid} never waited on a lock`);
}

async function waitForBackendIntegrityLockWait(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await getTestDb().execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks
        WHERE pid = ${backendPid}
          AND locktype = 'advisory'
          AND classid = 1000302
          AND NOT granted
      ) AS waiting
    `);
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backup relationship backend ${backendPid} never waited in namespace 1000302`);
}

async function backupCandidateLocks(backendPid: number, candidateId: string): Promise<{
  profile: boolean;
  destination: boolean;
}> {
  const [row] = await getTestDb().execute<{ profile: boolean; destination: boolean }>(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks
        WHERE pid = ${backendPid}
          AND locktype = 'advisory'
          AND classid = 1000302
          AND objid = (hashtext(${'ref:backup_profiles:' + candidateId})::bigint & 4294967295)
          AND granted
      ) AS profile,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks
        WHERE pid = ${backendPid}
          AND locktype = 'advisory'
          AND classid = 1000302
          AND objid = (hashtext(${'ref:backup_configs:' + candidateId})::bigint & 4294967295)
          AND granted
      ) AS destination
  `);
  return row ?? { profile: false, destination: false };
}

async function captureSqlState(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as { code?: string; cause?: { code?: string } };
    return wrapped.cause?.code ?? wrapped.code;
  }
}

async function captureSqlCause(work: () => Promise<unknown>): Promise<{
  code?: string;
  constraint_name?: string;
} | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as {
      code?: string;
      constraint_name?: string;
      cause?: { code?: string; constraint_name?: string };
    };
    return wrapped.cause ?? wrapped;
  }
}

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

  it('rejects an organization partner move that would orphan a partner-wide profile reference', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const org = await createOrganization({ partnerId: partnerA.id });
    const [profile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Organization reverse partner profile', orgId: null, partnerId: partnerA.id,
      selections: SERVER_SELECTIONS,
    }).returning());
    if (!profile) throw new Error('organization reverse profile insert failed');
    createdProfiles.push(profile.id);
    const { link } = await seedOrgPolicyWithLink(org.id);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(configPolicyFeatureLinks)
        .set({ featurePolicyId: profile.id })
        .where(eq(configPolicyFeatureLinks.id, link.id));
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link.id, orgId: org.id, partnerId: null,
        backupProfileId: profile.id, schedule: {}, retention: {},
      });
    });

    expect(await captureSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.update(organizations)
        .set({ partnerId: partnerB.id })
        .where(eq(organizations.id, org.id))))).toBe('23503');
    const [unchanged] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, org.id)));
    expect(unchanged?.partnerId).toBe(partnerA.id);
  });

  it('serializes an uncommitted normalized destination reference with a destination owner move', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [profile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Concurrent normalized profile', orgId: orgA.id, partnerId: null,
      selections: SERVER_SELECTIONS,
    }).returning());
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgA.id, name: 'Concurrent normalized destination', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
      name: 'Concurrent normalized backup policy', orgId: orgA.id, partnerId: null, status: 'active',
    }).returning());
    if (!profile || !destination || !policy) throw new Error('concurrent backup fixture insert failed');
    createdProfiles.push(profile.id);
    createdConfigs.push(destination.id);
    createdPolicies.push(policy.id);

    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const mover = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const inserted = deferred<{ linkId: string; settingsId: string }>();
    const releaseHolder = deferred<void>();
    const moverEntered = deferred<number>();
    let holderWork: Promise<void> | undefined;
    let moverWork: Promise<string | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        const [link] = await tx<{ id: string }[]>`
          INSERT INTO public.config_policy_feature_links
            (config_policy_id, feature_type, feature_policy_id)
          VALUES (${policy.id}, 'backup', ${profile.id})
          RETURNING id
        `;
        if (!link) throw new Error('concurrent backup link insert failed');
        const [settings] = await tx<{ id: string }[]>`
          INSERT INTO public.config_policy_backup_settings
            (feature_link_id, org_id, partner_id, backup_profile_id,
             destination_config_id, schedule, retention)
          VALUES (${link.id}, ${orgA.id}, NULL, ${profile.id}, ${destination.id}, '{}'::jsonb, '{}'::jsonb)
          RETURNING id
        `;
        if (!settings) throw new Error('concurrent backup settings insert failed');
        inserted.resolve({ linkId: link.id, settingsId: settings.id });
        await releaseHolder.promise;
      });
      const insertedRows = await waitForRaceSignal(
        inserted.promise,
        holderWork,
        'backup-settings insert holder',
      );

      moverWork = captureSqlState(() => mover.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing backup mover backend pid');
        moverEntered.resolve(backend.pid);
        await tx`
          UPDATE public.backup_configs
          SET org_id = ${orgB.id}
          WHERE id = ${destination.id}
        `;
      }));
      const moverPid = await waitForRaceSignal(
        moverEntered.promise,
        moverWork,
        'backup-destination mover',
      );
      await waitForBackendLockWait(moverPid);
      releaseHolder.resolve();
      await holderWork;
      expect(await moverWork).toBe('23503');

      await expect(admin.execute(sql`
        SELECT public.breeze_validate_config_policy_backup_settings(
          settings.feature_link_id, settings.org_id, settings.partner_id,
          settings.backup_profile_id, settings.destination_config_id
        )
        FROM public.config_policy_backup_settings settings
        WHERE settings.id = ${insertedRows.settingsId}::uuid
      `)).resolves.toBeDefined();
      const [parity] = await admin.execute<{ valid: boolean }>(sql`
        SELECT public.breeze_backup_feature_settings_parity_is_valid(
          ${insertedRows.linkId}::uuid
        ) AS valid
      `);
      expect(parity?.valid).toBe(true);
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holderWork, moverWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, mover);
    }
  }, 20_000);

  it('co-locks profile and destination candidates with the same physical UUID', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const sharedId = randomUUID();
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      id: sharedId, orgId: orgA.id, name: 'Shared candidate destination', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    if (!destination) throw new Error('shared candidate destination insert failed');
    createdConfigs.push(destination.id);

    const configMover = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const profileInserter = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const configMoved = deferred<void>();
    const releaseConfigMove = deferred<void>();
    const profileEntered = deferred<number>();
    const profileInserted = deferred<void>();
    const releaseProfileInsert = deferred<void>();
    let configBackendPid: number | undefined;
    let configWork: Promise<void> | undefined;
    let profileWork: Promise<string | undefined> | undefined;
    try {
      configWork = configMover.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing config candidate backend pid');
        configBackendPid = backend.pid;
        await tx`UPDATE public.backup_configs SET org_id = ${orgB.id} WHERE id = ${sharedId}`;
        configMoved.resolve();
        await releaseConfigMove.promise;
      });
      await waitForRaceSignal(
        configMoved.promise,
        configWork,
        'backup-config candidate mover',
      );
      expect(await backupCandidateLocks(configBackendPid!, sharedId)).toEqual({
        profile: true, destination: true,
      });

      profileWork = captureSqlState(() => profileInserter.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing profile candidate backend pid');
        profileEntered.resolve(backend.pid);
        await tx`
          INSERT INTO public.backup_profiles
            (id, name, org_id, partner_id, selections)
          VALUES (${sharedId}, 'Shared candidate profile', ${orgA.id}, NULL, ${JSON.stringify(SERVER_SELECTIONS)}::jsonb)
        `;
        profileInserted.resolve();
        await releaseProfileInsert.promise;
      }));
      const profilePid = await waitForRaceSignal(
        profileEntered.promise,
        profileWork,
        'backup-profile candidate inserter',
      );
      await waitForBackendIntegrityLockWait(profilePid);
      releaseConfigMove.resolve();
      await configWork;
      await waitForRaceSignal(
        profileInserted.promise,
        profileWork,
        'backup-profile candidate insert',
      );
      expect(await backupCandidateLocks(profilePid, sharedId)).toEqual({
        profile: true, destination: true,
      });
      releaseProfileInsert.resolve();
      expect(await profileWork).toBeUndefined();
      createdProfiles.push(sharedId);
    } finally {
      releaseConfigMove.resolve();
      releaseProfileInsert.resolve();
      await Promise.allSettled([configWork, profileWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(configMover, profileInserter);
    }
  }, 20_000);

  it('serializes same-UUID profile and destination reverse writers on both candidate identities', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const sharedId = randomUUID();
    const [destination] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      id: sharedId, orgId: orgA.id, name: 'Reverse race destination', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    const [profile] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      id: sharedId, name: 'Reverse race profile', orgId: orgA.id, partnerId: null,
      selections: SERVER_SELECTIONS,
    }).returning());
    if (!destination || !profile) throw new Error('reverse candidate race fixture insert failed');
    createdConfigs.push(sharedId);
    createdProfiles.push(sharedId);

    const profileMover = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const configMover = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const profileMoved = deferred<number>();
    const releaseProfileMove = deferred<void>();
    const configEntered = deferred<number>();
    const configMoved = deferred<void>();
    const releaseConfigMove = deferred<void>();
    let profileWork: Promise<string | undefined> | undefined;
    let configWork: Promise<string | undefined> | undefined;
    try {
      profileWork = captureSqlState(() => profileMover.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing reverse profile backend pid');
        await tx`UPDATE public.backup_profiles SET org_id = ${orgB.id} WHERE id = ${sharedId}`;
        profileMoved.resolve(backend.pid);
        await releaseProfileMove.promise;
      }));
      const profilePid = await waitForRaceSignal(
        profileMoved.promise,
        profileWork,
        'backup-profile reverse mover',
      );
      expect(await backupCandidateLocks(profilePid, sharedId)).toEqual({
        profile: true, destination: true,
      });

      configWork = captureSqlState(() => configMover.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing reverse config backend pid');
        configEntered.resolve(backend.pid);
        await tx`UPDATE public.backup_configs SET org_id = ${orgB.id} WHERE id = ${sharedId}`;
        configMoved.resolve();
        await releaseConfigMove.promise;
      }));
      const configPid = await waitForRaceSignal(
        configEntered.promise,
        configWork,
        'backup-config reverse mover',
      );
      await waitForBackendIntegrityLockWait(configPid);
      releaseProfileMove.resolve();
      expect(await profileWork).toBeUndefined();
      await waitForRaceSignal(
        configMoved.promise,
        configWork,
        'backup-config reverse move',
      );
      expect(await backupCandidateLocks(configPid, sharedId)).toEqual({
        profile: true, destination: true,
      });
      releaseConfigMove.resolve();
      expect(await configWork).toBeUndefined();
    } finally {
      releaseProfileMove.resolve();
      releaseConfigMove.resolve();
      await Promise.allSettled([profileWork, configWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(profileMover, configMover);
    }
  }, 20_000);

  it('locks every bulk settings candidate, rejects owner moves, and preserves destination SET NULL deletes', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const profiles = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values([
      { name: 'Bulk profile A', orgId: orgA.id, partnerId: null, selections: SERVER_SELECTIONS },
      { name: 'Bulk profile B', orgId: orgA.id, partnerId: null, selections: SERVER_SELECTIONS },
    ]).returning());
    const destinations = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values([
      { orgId: orgA.id, name: 'Bulk destination A', type: 'file', provider: 's3', providerConfig: {} },
      { orgId: orgA.id, name: 'Bulk destination B', type: 'file', provider: 's3', providerConfig: {} },
    ]).returning());
    if (profiles.length !== 2 || destinations.length !== 2) {
      throw new Error('bulk backup serialization fixture insert failed');
    }
    createdProfiles.push(...profiles.map((row) => row.id));
    createdConfigs.push(...destinations.map((row) => row.id));

    const settingsIds: string[] = [];
    await withDbAccessContext(SYSTEM_CTX, async () => {
      for (let index = 0; index < 2; index += 1) {
        const [policy] = await db.insert(configurationPolicies).values({
          name: `Bulk serialization policy ${index}`, orgId: orgA.id, partnerId: null, status: 'active',
        }).returning();
        if (!policy) throw new Error('bulk backup policy insert failed');
        createdPolicies.push(policy.id);
        const [link] = await db.insert(configPolicyFeatureLinks).values({
          configPolicyId: policy.id, featureType: 'backup', featurePolicyId: profiles[index]!.id,
        }).returning();
        const [settings] = await db.insert(configPolicyBackupSettings).values({
          featureLinkId: link!.id, orgId: orgA.id, partnerId: null,
          backupProfileId: profiles[index]!.id,
          destinationConfigId: destinations[index]!.id,
          schedule: {}, retention: {},
        }).returning();
        if (!settings) throw new Error('bulk backup settings insert failed');
        settingsIds.push(settings.id);
      }
    });

    const bulkWriter = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const bulkUpdated = deferred<number>();
    const releaseBulkUpdate = deferred<void>();
    let bulkWork: Promise<void> | undefined;
    try {
      bulkWork = bulkWriter.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing bulk settings backend pid');
        await tx`
          UPDATE public.config_policy_backup_settings
          SET destination_config_id = CASE id
            WHEN ${settingsIds[0]!}::uuid THEN ${destinations[1]!.id}::uuid
            WHEN ${settingsIds[1]!}::uuid THEN ${destinations[0]!.id}::uuid
            ELSE destination_config_id
          END
          WHERE id IN (${settingsIds[0]!}::uuid, ${settingsIds[1]!}::uuid)
        `;
        bulkUpdated.resolve(backend.pid);
        await releaseBulkUpdate.promise;
      });
      const bulkPid = await waitForRaceSignal(
        bulkUpdated.promise,
        bulkWork,
        'bulk backup-settings writer',
      );
      for (const candidateId of [
        profiles[0]!.id, profiles[1]!.id, destinations[0]!.id, destinations[1]!.id,
      ]) {
        expect(await backupCandidateLocks(bulkPid, candidateId)).toEqual({
          profile: true, destination: true,
        });
      }
      releaseBulkUpdate.resolve();
      await bulkWork;
    } finally {
      releaseBulkUpdate.resolve();
      await Promise.allSettled([bulkWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(bulkWriter);
    }

    expect(await captureSqlState(() => admin.execute(sql`
      UPDATE public.backup_profiles
      SET org_id = ${orgB.id}::uuid
      WHERE id IN (${profiles[0]!.id}::uuid, ${profiles[1]!.id}::uuid)
    `))).toBe('23503');
    expect(await captureSqlState(() => admin.execute(sql`
      DELETE FROM public.backup_configs
      WHERE id IN (${destinations[0]!.id}::uuid, ${destinations[1]!.id}::uuid)
    `))).toBeUndefined();

    const [remaining] = await admin.execute<{
      profiles: number; destinations: number; nulledDestinations: number;
    }>(sql`
      SELECT
        (SELECT count(*)::integer FROM public.backup_profiles
          WHERE id IN (${profiles[0]!.id}::uuid, ${profiles[1]!.id}::uuid)) AS profiles,
        (SELECT count(*)::integer FROM public.backup_configs
          WHERE id IN (${destinations[0]!.id}::uuid, ${destinations[1]!.id}::uuid)) AS destinations,
        (SELECT count(*)::integer FROM public.config_policy_backup_settings
          WHERE id IN (${settingsIds[0]!}::uuid, ${settingsIds[1]!}::uuid)
            AND destination_config_id IS NULL) AS "nulledDestinations"
    `);
    expect(remaining).toEqual({ profiles: 2, destinations: 0, nulledDestinations: 2 });
  }, 20_000);

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

  it('resolves FORCE-RLS backup rows via in-body system elevation for non-bypass B definers', async () => {
    const admin = getTestDb();
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const [profileA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupProfiles).values({
      name: 'Non-bypass profile A', orgId: orgA.id, partnerId: null,
      selections: SERVER_SELECTIONS,
    }).returning());
    const [destinationA] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgA.id, name: 'Non-bypass destination A', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    const [destinationA2] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgA.id, name: 'Non-bypass destination A2', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    const [destinationB] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(backupConfigs).values({
      orgId: orgB.id, name: 'Non-bypass destination B', type: 'file',
      provider: 's3', providerConfig: {},
    }).returning());
    const [policyA] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(configurationPolicies).values({
        name: 'Non-bypass policy A', orgId: orgA.id, partnerId: null, status: 'active',
      }).returning());
    if (!profileA || !destinationA || !destinationA2 || !destinationB || !policyA) {
      throw new Error('non-bypass backup fixture insert failed');
    }
    createdProfiles.push(profileA.id);
    createdConfigs.push(destinationA.id, destinationA2.id, destinationB.id);
    createdPolicies.push(policyA.id);
    const [linkA, settingsA] = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policyA.id, featureType: 'backup', featurePolicyId: profileA.id,
      }).returning();
      if (!link) throw new Error('non-bypass backup link insert failed');
      const [settings] = await db.insert(configPolicyBackupSettings).values({
        featureLinkId: link.id, orgId: orgA.id, partnerId: null,
        backupProfileId: profileA.id, destinationConfigId: destinationA.id,
        schedule: {}, retention: {},
      }).returning();
      return [link, settings];
    });
    if (!linkA || !settingsA) throw new Error('non-bypass backup relationship seed failed');

    const [current] = await admin.execute<{ roleName: string }>(sql`
      SELECT current_user AS "roleName"
    `);
    if (!current) throw new Error('database owner probe failed');
    const ownerRole = `breeze_backup_b_owner_${randomUUID().replaceAll('-', '')}`;
    await admin.execute(sql.raw(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`));
    try {
      await admin.execute(sql.raw(`
        GRANT USAGE ON SCHEMA public TO ${ownerRole};
        GRANT SELECT ON public.config_policy_backup_settings,
          public.config_policy_feature_links, public.configuration_policies,
          public.organizations, public.backup_profiles, public.backup_configs TO ${ownerRole};
        GRANT UPDATE ON public.config_policy_backup_settings,
          public.config_policy_feature_links, public.configuration_policies,
          public.organizations, public.backup_profiles, public.backup_configs TO ${ownerRole};
        GRANT EXECUTE ON FUNCTION
          public.breeze_validate_config_policy_backup_settings(uuid, uuid, uuid, uuid, uuid),
          public.breeze_validate_config_policy_feature_reference(uuid, public.config_feature_type, uuid),
          public.breeze_backup_feature_settings_parity_is_valid(uuid) TO ${ownerRole};
        ALTER FUNCTION public.breeze_enforce_backup_settings_stmt() OWNER TO ${ownerRole};
        ALTER FUNCTION public.breeze_revalidate_backup_refs_stmt() OWNER TO ${ownerRole};
      `));

      const [roleFlags] = await admin.execute<{ superuser: boolean; bypass: boolean }>(sql.raw(`
        SELECT rolsuper AS superuser, rolbypassrls AS bypass
        FROM pg_catalog.pg_roles WHERE rolname = '${ownerRole}'
      `));
      expect(roleFlags).toEqual({ superuser: false, bypass: false });
      const configured = await admin.execute<{ name: string; owner: string; config: string[] }>(sql`
        SELECT p.proname AS name, owner.rolname AS owner, p.proconfig AS config
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
        WHERE n.nspname = 'public'
          AND p.proname IN ('breeze_enforce_backup_settings_stmt', 'breeze_revalidate_backup_refs_stmt')
        ORDER BY p.proname
      `);
      expect(configured).toHaveLength(2);
      // Elevation moved into the function bodies (set_config save/restore):
      // prod's non-superuser migration role cannot SET custom GUCs as
      // function attributes (42501), so proconfig must stay breeze.*-free.
      expect(configured.every((fn) => fn.owner === ownerRole
        && fn.config.includes('search_path=pg_catalog, public')
        && !fn.config.some((entry) => entry.startsWith('breeze.')))).toBe(true);

      const setUnrelatedCallerContext = async (tx: Parameters<Parameters<typeof admin.transaction>[0]>[0]) => {
        await tx.execute(sql`SELECT pg_catalog.set_config('breeze.scope', 'organization', true)`);
        await tx.execute(sql`SELECT pg_catalog.set_config('breeze.org_id', ${orgB.id}, true)`);
        await tx.execute(sql`SELECT pg_catalog.set_config('breeze.accessible_org_ids', ${orgB.id}, true)`);
        await tx.execute(sql`SELECT pg_catalog.set_config(
          'breeze.accessible_partner_ids', ${partnerB.id}, true
        )`);
        await tx.execute(sql`SELECT pg_catalog.set_config(
          'breeze.current_partner_id', ${partnerB.id}, true
        )`);
      };

      await expect(admin.transaction(async (tx) => {
        await setUnrelatedCallerContext(tx);
        await tx.update(configPolicyBackupSettings)
          .set({ destinationConfigId: destinationA2.id })
          .where(eq(configPolicyBackupSettings.id, settingsA.id));
      })).resolves.toBeUndefined();
      const [forwardUpdated] = await admin.select({
        destinationConfigId: configPolicyBackupSettings.destinationConfigId,
      }).from(configPolicyBackupSettings)
        .where(eq(configPolicyBackupSettings.id, settingsA.id));
      expect(forwardUpdated?.destinationConfigId).toBe(destinationA2.id);

      expect(await captureSqlCause(() => admin.transaction(async (tx) => {
        await setUnrelatedCallerContext(tx);
        await tx.update(configPolicyBackupSettings)
          .set({ destinationConfigId: destinationB.id })
          .where(eq(configPolicyBackupSettings.id, settingsA.id));
      }))).toMatchObject({
        code: '23503',
        constraint_name: 'config_policy_backup_settings_destination_owner_fk',
      });

      expect(await captureSqlCause(() => admin.transaction(async (tx) => {
        await setUnrelatedCallerContext(tx);
        await tx.update(backupProfiles)
          .set({ orgId: orgB.id })
          .where(eq(backupProfiles.id, profileA.id));
      }))).toMatchObject({
        code: '23503',
        constraint_name: 'config_policy_backup_settings_profile_owner_fk',
      });

      const [unchanged] = await admin.select({
        destinationConfigId: configPolicyBackupSettings.destinationConfigId,
        profileOrgId: backupProfiles.orgId,
      }).from(configPolicyBackupSettings)
        .innerJoin(backupProfiles, eq(backupProfiles.id, configPolicyBackupSettings.backupProfileId))
        .where(eq(configPolicyBackupSettings.id, settingsA.id));
      expect(unchanged).toEqual({ destinationConfigId: destinationA2.id, profileOrgId: orgA.id });
    } finally {
      const quotedCurrent = `"${current.roleName.replaceAll('"', '""')}"`;
      await admin.execute(sql.raw(`REASSIGN OWNED BY ${ownerRole} TO ${quotedCurrent}`));
      await admin.execute(sql.raw(`DROP OWNED BY ${ownerRole}`));
      await admin.execute(sql.raw(`DROP ROLE ${ownerRole}`));
    }
  }, 30_000);

  it('migrations are idempotent and keep serialization, parity, and export trigger contracts intact', async () => {
    const parityMigration = readFileSync(BACKUP_PARITY_MIGRATION_FILE, 'utf8');
    const serializationMigration = readFileSync(BACKUP_SERIALIZATION_MIGRATION_FILE, 'utf8');
    const adminDb = getTestDb();
    await expect(adminDb.execute(sql.raw(parityMigration))).resolves.toBeDefined();
    await expect(adminDb.execute(sql.raw(parityMigration))).resolves.toBeDefined();
    await expect(adminDb.execute(sql.raw(serializationMigration))).resolves.toBeDefined();
    await expect(adminDb.execute(sql.raw(serializationMigration))).resolves.toBeDefined();
    await ensureAppRole();
    const [result] = await adminDb.execute<{
      validate: boolean;
      enforce: boolean;
      serializeSettings: boolean;
      serializeReverse: boolean;
      publicSerializeSettings: boolean;
      publicSerializeReverse: boolean;
      inBodyElevationConfig: boolean;
      fixedPathBodies: boolean;
      appSuper: boolean;
      appBypassRls: boolean;
      deferredParityCount: number;
      normalizedExportCount: number;
      targetExportCount: number;
      serializationTriggers: string[];
    }>(sql`
      WITH serialization_functions AS (
        SELECT p.* FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('breeze_enforce_backup_settings_stmt', 'breeze_revalidate_backup_refs_stmt')
      ), serialization_trigger_rows AS (
        SELECT c.relname || '.' || t.tgname AS name, t.tgtype
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        WHERE t.tgfoid IN (SELECT oid FROM serialization_functions)
          AND NOT t.tgisinternal
      )
      SELECT
        has_function_privilege(
          'breeze_app', 'public.breeze_backup_feature_settings_parity_is_valid(uuid)', 'EXECUTE'
        ) AS validate,
        has_function_privilege(
          'breeze_app', 'public.breeze_enforce_backup_feature_settings_parity()', 'EXECUTE'
        ) AS enforce,
        has_function_privilege(
          'breeze_app', 'public.breeze_enforce_backup_settings_stmt()', 'EXECUTE'
        ) AS "serializeSettings",
        has_function_privilege(
          'breeze_app', 'public.breeze_revalidate_backup_refs_stmt()', 'EXECUTE'
        ) AS "serializeReverse",
        has_function_privilege(
          'public', 'public.breeze_enforce_backup_settings_stmt()', 'EXECUTE'
        ) AS "publicSerializeSettings",
        has_function_privilege(
          'public', 'public.breeze_revalidate_backup_refs_stmt()', 'EXECUTE'
        ) AS "publicSerializeReverse",
        (
          -- Elevation is in-body (set_config save/restore); the attribute form
          -- needs superuser in prod, so proconfig must stay breeze.*-free.
          SELECT count(*) = 2 AND bool_and(
            prosecdef
            AND proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
            AND NOT EXISTS (
              SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'breeze.%'
            )
          ) FROM serialization_functions
        ) AS "inBodyElevationConfig",
        (
          SELECT count(*) = 2
            AND bool_and(pg_catalog.strpos(pg_catalog.pg_get_functiondef(oid), 'EXECUTE format') = 0)
          FROM serialization_functions
        ) AS "fixedPathBodies",
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') AS "appSuper",
        (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') AS "appBypassRls",
        (
          SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname IN (
            'config_policy_feature_links_backup_settings_parity',
            'config_policy_backup_settings_feature_parity'
          ) AND tgdeferrable AND tginitdeferred
        ) AS "deferredParityCount",
        (
          SELECT count(*)::integer FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'config_policy_backup_settings'
            AND t.tgname IN (
              'breeze_partner_export_normalized_insert',
              'breeze_partner_export_normalized_update',
              'breeze_partner_export_normalized_delete'
            ) AND (t.tgtype & 1) = 0
        ) AS "normalizedExportCount",
        (
          SELECT count(*)::integer FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.relname IN ('backup_profiles', 'backup_configs')
            AND t.tgname IN (
              'breeze_partner_export_configuration_insert',
              'breeze_partner_export_configuration_update',
              'breeze_partner_export_configuration_delete'
            ) AND (t.tgtype & 1) = 0
        ) AS "targetExportCount",
        (
          SELECT array_agg(name ORDER BY name) FROM serialization_trigger_rows
          WHERE (tgtype & 1) = 0
        ) AS "serializationTriggers"
    `);
    expect(result).toEqual({
      validate: false,
      enforce: false,
      serializeSettings: false,
      serializeReverse: false,
      publicSerializeSettings: false,
      publicSerializeReverse: false,
      inBodyElevationConfig: true,
      fixedPathBodies: true,
      appSuper: false,
      appBypassRls: false,
      deferredParityCount: 2,
      normalizedExportCount: 3,
      targetExportCount: 6,
      serializationTriggers: [
        'backup_configs.aa_backup_refs_config_delete',
        'backup_configs.aa_backup_refs_config_update',
        'backup_profiles.aa_backup_refs_profile_delete',
        'backup_profiles.aa_backup_refs_profile_insert',
        'backup_profiles.aa_backup_refs_profile_update',
        'config_policy_backup_settings.aa_backup_settings_delete',
        'config_policy_backup_settings.aa_backup_settings_insert',
        'config_policy_backup_settings.aa_backup_settings_update',
        'config_policy_feature_links.ab_backup_refs_link_delete',
        'config_policy_feature_links.ab_backup_refs_link_update',
        'configuration_policies.ab_backup_refs_policy_delete',
        'configuration_policies.ab_backup_refs_policy_update',
        'organizations.ab_backup_refs_org_update',
      ],
    });
  });
});
