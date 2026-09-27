/**
 * Real-PostgreSQL proof for the DB-enforced cross-org snapshot-identity
 * guarantee (backup_snapshots_storage_identity_snapshot_id_uq).
 *
 * The app-layer ownership check (findForeignSnapshotClaim) runs under the
 * CALLER'S OWN org-scoped RLS context on the two production paths
 * (backupProgress.ts via runWithAgentDbAccess, backupResultPersistence.ts via
 * runWithAgentOrgDbAccess), where a different org's row is not visible, so
 * the cross-org guarantee comes from the unique index. This test reproduces the
 * SAME context (`withDbAccessContext({ scope: 'organization', ... })`, never
 * system scope) and proves the DB-level unique index refuses the second
 * org's adoption regardless of what that session's RLS context can see.
 */
import './setup';

import { it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { backupConfigs, backupJobs, backupSnapshots, devices, organizations, partners, sites } from '../../db/schema';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seedTenant(label: string, sharedStorageIdentity: string) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [partner] = await db.insert(partners).values({
    name: `${label} Partner ${unique}`,
    slug: `${label}-partner-${unique}`.toLowerCase(),
    type: 'msp',
    plan: 'pro',
    status: 'active',
  }).returning({ id: partners.id });
  const [org] = await db.insert(organizations).values({
    currencyCode: 'USD',
    partnerId: partner!.id,
    name: `${label} Org ${unique}`,
    slug: `${label}-org-${unique}`.toLowerCase(),
    type: 'customer',
    status: 'active',
  }).returning({ id: organizations.id });
  const [site] = await db.insert(sites).values({ orgId: org!.id, name: `${label} Site ${unique}` })
    .returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org!.id,
    siteId: site!.id,
    agentId: `${label}-agent-${unique}`,
    hostname: `${label}-host-${unique}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org!.id,
    name: `${label} Config ${unique}`,
    type: 'file',
    provider: 'local',
    providerConfig: {},
  }).returning({ id: backupConfigs.id });
  const [job] = await db.insert(backupJobs).values({
    orgId: org!.id,
    configId: config!.id,
    deviceId: device!.id,
    status: 'running',
    startedAt: new Date(),
    lastProgressAt: new Date(),
    // Simulates two orgs' configs pointed at the SAME bucket/credential set —
    // the exact "destination shared across orgs" precondition under
    // test.
    storageIdentity: sharedStorageIdentity,
  }).returning({ id: backupJobs.id });

  return { orgId: org!.id, deviceId: device!.id, jobId: job!.id };
}

runDb(
  'refuses the second org\'s adoption of a snapshot id another org already claimed on a shared destination, under each org\'s own request-scoped RLS context',
  async () => {
    const sharedStorageIdentity = `shared-bucket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const orgA = await withSystemDbAccessContext(() => seedTenant('org-a', sharedStorageIdentity));
    const orgB = await withSystemDbAccessContext(() => seedTenant('org-b', sharedStorageIdentity));

    // Org A's device reports the terminal result FIRST, under org A's own
    // request-scoped RLS context — exactly runWithAgentOrgDbAccess's shape,
    // never system scope.
    const firstResult = await withDbAccessContext(orgContext(orgA.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: orgA.jobId,
        orgId: orgA.orgId,
        deviceId: orgA.deviceId,
        resultStatus: 'completed',
        result: { snapshotId, filesBackedUp: 5, bytesBackedUp: 1000 },
      })
    );
    expect(firstResult.applied).toBe(true);
    expect(firstResult.snapshotDbId).not.toBeNull();

    // Org B's device reports the SAME snapshot id, under ITS OWN
    // request-scoped RLS context — org A's row is invisible to org B's
    // SELECT (breeze_has_org_access only admits org B), so
    // findForeignSnapshotClaim returns null and the code proceeds to INSERT.
    // The DB-level unique constraint must refuse it regardless.
    const secondResult = await withDbAccessContext(orgContext(orgB.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: orgB.jobId,
        orgId: orgB.orgId,
        deviceId: orgB.deviceId,
        resultStatus: 'completed',
        result: { snapshotId, filesBackedUp: 999, bytesBackedUp: 999999 },
      })
    );
    expect(secondResult.applied).toBe(true);
    expect(secondResult.snapshotDbId).toBeNull();

    // Exactly one backup_snapshots row exists for this snapshot id — the
    // actual product-verified restore point — and it belongs to org A / org
    // A's device. Org B never adopted it: no second row, and no read/write
    // access to org A's row or the objects it represents.
    //
    // NOT asserted here (known, tracked follow-up): org B's OWN backup_jobs row can still end up with its own
    // snapshot_id column set to this same string, because that field's
    // ownership check (findForeignSnapshotClaim, same-org only under RLS)
    // cannot see org A's row either. That write only touches org B's own
    // row, grants no access to org A's data, and carries none of the
    // "verified restore point" semantics the backup_snapshots row does —
    // reconcile.ts's own foreignClaimed check additionally treats ANY
    // foreign job claim (which this now is, from reconcile's system-scoped
    // point of view) as a reason to refuse auto-adoption, which fails
    // closed.
    await withSystemDbAccessContext(async () => {
      const rows = await db.select().from(backupSnapshots).where(eq(backupSnapshots.snapshotId, snapshotId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orgId).toBe(orgA.orgId);
      expect(rows[0]!.deviceId).toBe(orgA.deviceId);

      await db.delete(backupSnapshots).where(eq(backupSnapshots.snapshotId, snapshotId));
      await db.delete(backupJobs).where(eq(backupJobs.id, orgA.jobId));
      await db.delete(backupJobs).where(eq(backupJobs.id, orgB.jobId));
    });
  }
);
