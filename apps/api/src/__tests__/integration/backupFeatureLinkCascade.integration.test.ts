/**
 * Regression (#2302): Deleting a configuration policy — or removing its Backup
 * feature link — returned a 500 once the backup had produced any backup_jobs row
 * (a single failed run is enough). `removeFeatureLink` is a bare delete of
 * config_policy_feature_links that relies entirely on FK ON DELETE CASCADE for
 * child cleanup (like every other feature type). But backup_jobs.feature_link_id
 * was the ONE feature-link child FK defined WITHOUT ON DELETE CASCADE, so the
 * delete hit `backup_jobs_feature_link_id_fkey` (23503) and could never succeed.
 *
 * The fix (2026-07-14-backup-feature-link-cascade.sql) adds ON DELETE CASCADE to
 * the backup feature-link -> jobs -> {snapshots,verifications} chain, matching
 * every sibling feature child. This test seeds that chain against a real DB and
 * proves removeFeatureLink now succeeds and cascade-deletes the dependent backup
 * rows. Before the migration it is RED (removeFeatureLink throws 23503); after,
 * GREEN. RLS is irrelevant here — the bug is a DB-level FK constraint — so we run
 * the delete under a system context, the same path a background caller uses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, sites, devices } from '../../db/schema';
import { configurationPolicies, configPolicyFeatureLinks } from '../../db/schema/configurationPolicies';
import { backupConfigs, backupJobs, backupSnapshots } from '../../db/schema/backup';
import { backupVerifications } from '../../db/schema/backupVerification';
import { removeFeatureLink } from '../../services/configurationPolicy';

let orgId: string;
let policyId: string;
let featureLinkId: string;
let backupJobId: string;
let orgContext: DbAccessContext;

beforeEach(async () => {
  const tdb = getTestDb();
  const sfx = `${Date.now()}-${Math.floor(performance.now())}`;

  const [p] = await tdb
    .insert(partners)
    .values({ name: 'BFLC', slug: `bflc-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await tdb
    .insert(organizations)
    .values({ partnerId: p!.id, name: 'BFLC Org', slug: `bflc-org-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [site] = await tdb.insert(sites).values({ orgId, name: 'HQ' }).returning({ id: sites.id });
  const [device] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId: site!.id,
      agentId: `bflc-${sfx}`,
      hostname: `bflc-${sfx}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
    })
    .returning({ id: devices.id });

  const [policy] = await tdb
    .insert(configurationPolicies)
    .values({ orgId, name: 'BFLC Policy' })
    .returning({ id: configurationPolicies.id });
  policyId = policy!.id;
  const [link] = await tdb
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'backup' })
    .returning({ id: configPolicyFeatureLinks.id });
  featureLinkId = link!.id;

  const [cfg] = await tdb
    .insert(backupConfigs)
    .values({
      orgId,
      name: 'BFLC Config',
      type: 'file',
      provider: 'local',
      providerConfig: {},
    })
    .returning({ id: backupConfigs.id });

  // The backup ran at least once (even a failed run inserts a backup_jobs row
  // carrying the feature_link_id — this is what blocked deletion).
  const [job] = await tdb
    .insert(backupJobs)
    .values({
      orgId,
      configId: cfg!.id,
      featureLinkId,
      deviceId: device!.id,
      status: 'failed',
    })
    .returning({ id: backupJobs.id });
  backupJobId = job!.id;

  // Plus dependent children that would themselves block the backup_jobs delete
  // without their own ON DELETE CASCADE.
  await tdb.insert(backupSnapshots).values({
    orgId,
    jobId: backupJobId,
    deviceId: device!.id,
    snapshotId: `snap-${sfx}`,
  });
  await tdb.insert(backupVerifications).values({
    orgId,
    deviceId: device!.id,
    backupJobId,
    verificationType: 'integrity',
    status: 'failed',
    startedAt: new Date(),
  });

  // The real endpoints delete the feature link under an org-scoped breeze_app
  // context; exercise that path rather than a system context.
  orgContext = {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: null,
    userId: null,
    currentPartnerId: p!.id,
  };
});

describe('#2302 backup feature-link FK actions', () => {
  it('removeFeatureLink succeeds and detaches (SET NULL) backup history without destroying it', async () => {
    const tdb = getTestDb();

    // Precondition: the job (and children) exist and reference the feature link.
    expect(
      await tdb.select().from(backupJobs).where(eq(backupJobs.featureLinkId, featureLinkId))
    ).toHaveLength(1);

    // The reported code path, under the endpoint's org-scoped context. RED before
    // the migration: threw PostgresError 23503 on backup_jobs_feature_link_id_fkey.
    const deleted = await withDbAccessContext(orgContext, () =>
      removeFeatureLink(featureLinkId, policyId)
    );
    expect(deleted?.id).toBe(featureLinkId);

    // The link is gone...
    expect(
      await tdb.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, featureLinkId))
    ).toHaveLength(0);

    // ...but the backup history SURVIVES, detached (feature_link_id nulled), so a
    // device's backup jobs / snapshots / verifications are not silently destroyed
    // just because the Backup feature was unlinked.
    const [job] = await tdb.select().from(backupJobs).where(eq(backupJobs.id, backupJobId));
    expect(job).toBeDefined();
    expect(job!.featureLinkId).toBeNull();
    expect(
      await tdb.select().from(backupSnapshots).where(eq(backupSnapshots.jobId, backupJobId))
    ).toHaveLength(1);
    expect(
      await tdb.select().from(backupVerifications).where(eq(backupVerifications.backupJobId, backupJobId))
    ).toHaveLength(1);
  });

  it('deleting a backup_job cascades its snapshots and verifications', async () => {
    // The children kept ON DELETE CASCADE: they have no meaning without their job
    // row, so retention / org-delete removing a backup_job takes them with it.
    const tdb = getTestDb();
    await tdb.delete(backupJobs).where(eq(backupJobs.id, backupJobId));
    expect(
      await tdb.select().from(backupSnapshots).where(eq(backupSnapshots.jobId, backupJobId))
    ).toHaveLength(0);
    expect(
      await tdb.select().from(backupVerifications).where(eq(backupVerifications.backupJobId, backupJobId))
    ).toHaveLength(0);
  });
});
