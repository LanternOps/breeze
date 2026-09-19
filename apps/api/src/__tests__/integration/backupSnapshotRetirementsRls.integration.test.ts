import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { backupConfigs, backupSnapshotRetirements, devices, sites } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Real DbAccessContext shape (apps/api/src/db/index.ts) has NO `partnerId`
// field -- mirrors the established `orgContext` helper convention used
// elsewhere in this suite (e.g. agentRollbackRls.integration.test.ts).
function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

// D18 §3.3: shape-1 RLS forge -- an org-scoped context for org B must not be
// able to insert (or read) a retirement row stamped with org A's id.
runDb('forges a cross-tenant insert on backup_snapshot_retirements and gets 42501', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { orgAId, orgBId, configId, deviceId } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [site] = await db.insert(sites).values({ orgId: orgA.id, name: `RLSS ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: orgA.id, siteId: site!.id, agentId: `rlsa-agent-${unique}`, hostname: `rlsa-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({ orgId: orgA.id, name: `RLSC ${unique}`, type: 'file', provider: 'local', providerConfig: {} }).returning({ id: backupConfigs.id });
    return { orgAId: orgA.id, orgBId: orgB.id, configId: config!.id, deviceId: device!.id };
  });

  await expect(
    withDbAccessContext(orgContext(orgBId), () =>
      db.insert(backupSnapshotRetirements).values({
        orgId: orgAId, // forged: org B's context, org A's row
        configId,
        deviceId,
        snapshotId: `forge-${unique}`,
        storageIdentity: `local::/tmp/forge-${unique}`,
        backupType: 'file',
        reason: 'manual',
      })
    )
    // A Drizzle `.insert(...)` call's rejection wraps the real Postgres error
    // under `.cause`, NOT a top-level `.code` -- confirmed against
    // agentRollbackRls.integration.test.ts (`{ cause: { code: '23505' } }`).
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});

// Review fix: the INSERT-side 42501 forge above proves the WITH CHECK clause
// works, but says nothing about the SELECT policy — a table with a broken or
// missing breeze_app grant could ALSO reject every statement with 42501,
// making the insert-only test pass for the wrong reason. Prove the read side
// separately: a legitimately-written row for org A must come back as ZERO
// rows (not an error) under org B's context, and must come back as the one
// row under org A's own context.
runDb('a legitimately written retirement row is invisible to a different org under SELECT, and visible to its own org', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { orgAId, orgBId, configId, deviceId, snapshotId } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [site] = await db.insert(sites).values({ orgId: orgA.id, name: `RLSS2 ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: orgA.id, siteId: site!.id, agentId: `rlsa2-agent-${unique}`, hostname: `rlsa2-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online' }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({ orgId: orgA.id, name: `RLSC2 ${unique}`, type: 'file', provider: 'local', providerConfig: {} }).returning({ id: backupConfigs.id });
    const snapId = `legit-${unique}`;
    await db.insert(backupSnapshotRetirements).values({
      orgId: orgA.id, configId: config!.id, deviceId: device!.id,
      snapshotId: snapId, storageIdentity: `local::/tmp/legit-${unique}`, backupType: 'file', reason: 'manual',
    });
    return { orgAId: orgA.id, orgBId: orgB.id, configId: config!.id, deviceId: device!.id, snapshotId: snapId };
  });

  const rowsUnderOrgB = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, snapshotId))
  );
  expect(rowsUnderOrgB.length).toBe(0);

  const rowsUnderOrgA = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(backupSnapshotRetirements).where(eq(backupSnapshotRetirements.snapshotId, snapshotId))
  );
  expect(rowsUnderOrgA.length).toBe(1);
  expect(rowsUnderOrgA[0]!.orgId).toBe(orgAId);
});
