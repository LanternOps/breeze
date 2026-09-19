/**
 * SEC-2026-09-05-026 — local_vaults must not pair one tenant's org_id with
 * another tenant's device_id. Org-axis RLS checks only the row's org_id, so a
 * composite FK is the database backstop for every present and future writer.
 */
import './setup';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupConfigs, backupJobs, backupSnapshots, devices, localVaults,
  organizations, partners, sites, vaultSnapshotInventory,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const partnerIds: string[] = [];
const vaultIds: string[] = [];

function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seed() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  partnerIds.push(partnerA.id, partnerB.id);
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [deviceA, deviceB] = await (getTestDb() as any).insert(devices).values([
    {
      orgId: orgA.id, siteId: siteA.id, agentId: `sec026-a-${randomUUID()}`,
      hostname: 'sec026-a', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1.0.0',
    },
    {
      orgId: orgB.id, siteId: siteB.id, agentId: `sec026-b-${randomUUID()}`,
      hostname: 'sec026-b', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1.0.0',
    },
  ]).returning({ id: devices.id });
  return { orgA, orgB, siteB, deviceA: deviceA!, deviceB: deviceB! };
}

afterAll(async () => {
  const admin = getTestDb() as any;
  if (vaultIds.length > 0) {
    const ids = sql.join(vaultIds.map((id) => sql`${id}`), sql`, `);
    await admin.delete(localVaults).where(sql`${localVaults.id} IN (${ids})`);
  }
  if (partnerIds.length > 0) {
    const ids = sql.join(partnerIds.map((id) => sql`${id}`), sql`, `);
    // Children first: the backup chain (config -> job -> snapshot) references
    // both devices and organizations, and vault_snapshot_inventory references
    // the snapshot, so an org-first delete would raise an FK violation.
    const orgScope = sql`(SELECT id FROM organizations WHERE partner_id IN (${ids}))`;
    await admin.delete(vaultSnapshotInventory).where(sql`${vaultSnapshotInventory.orgId} IN ${orgScope}`);
    await admin.delete(localVaults).where(sql`${localVaults.orgId} IN ${orgScope}`);
    await admin.delete(backupSnapshots).where(sql`${backupSnapshots.orgId} IN ${orgScope}`);
    await admin.delete(backupJobs).where(sql`${backupJobs.orgId} IN ${orgScope}`);
    await admin.delete(backupConfigs).where(sql`${backupConfigs.orgId} IN ${orgScope}`);
    await admin.delete(devices).where(sql`${devices.orgId} IN ${orgScope}`);
    await admin.delete(sites).where(sql`${sites.orgId} IN ${orgScope}`);
    await admin.delete(organizations).where(sql`${organizations.partnerId} IN (${ids})`);
    await admin.delete(partners).where(sql`${partners.id} IN (${ids})`);
  }
});

describe('local_vaults device/org composite FK (SEC-026)', () => {
  it('rejects a caller-org row that references another tenant device while allowing the matching pair', async () => {
    const { orgA, orgB, siteB, deviceA, deviceB } = await seed();
    let mismatchError: unknown;
    let mismatchedId: string | undefined;
    try {
      const [row] = await withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(localVaults).values({ orgId: orgA.id, deviceId: deviceB.id, vaultPath: '/synthetic/foreign' }).returning({ id: localVaults.id }),
      );
      mismatchedId = row?.id;
    } catch (error) {
      mismatchError = error;
    } finally {
      if (mismatchedId) await (getTestDb() as any).delete(localVaults).where(eq(localVaults.id, mismatchedId));
    }

    expect(mismatchError).toMatchObject({
      code: '23503', constraint_name: 'local_vaults_device_org_fkey',
    });

    const [allowed] = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.insert(localVaults).values({ orgId: orgA.id, deviceId: deviceA.id, vaultPath: '/synthetic/own' }).returning({ id: localVaults.id }),
    );
    expect(allowed?.id).toBeTypeOf('string');
    vaultIds.push(allowed!.id);

    const constraints = (await (getTestDb() as any).execute(sql`
      SELECT condeferrable, condeferred
      FROM pg_constraint
      WHERE conname = 'local_vaults_device_org_fkey'
        AND conrelid = 'local_vaults'::regclass
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
    expect(constraints).toEqual([{ condeferrable: true, condeferred: true }]);

    // Device moves are a sibling path: the existing SECURITY DEFINER device
    // cascade re-stamps local_vaults in the same transaction. The deferred FK
    // must permit that repair while still being valid at commit.
    await (getTestDb() as any)
      .update(devices)
      .set({ orgId: orgB.id, siteId: siteB.id })
      .where(eq(devices.id, deviceA.id));
    const [movedVault] = await (getTestDb() as any)
      .select({ orgId: localVaults.orgId })
      .from(localVaults)
      .where(eq(localVaults.id, allowed!.id));
    expect(movedVault?.orgId).toBe(orgB.id);
  });
});

/**
 * Forward-migration behaviour (SEC-026 review BLOCKER 1). The repair for a
 * historical mismatched row is RESTAMP-AND-DEACTIVATE, never DELETE:
 *
 *  - restamping from the device is what breeze_cascade_device_org_id() has
 *    done on every device move since 2026-05-18, so a pre-trigger benign move
 *    and the SEC-026 abuse path are indistinguishable here;
 *  - deleting would cascade vault_snapshot_inventory, which is recovery
 *    metadata for data on the VICTIM org's device;
 *  - deactivating stops an attacker-chosen vault_path from syncing under the
 *    corrected org until a human re-enables it.
 *
 * vault_snapshot_inventory keys on vault_id (not device_id), so the device
 * trigger never covers it — the migration restamps it explicitly.
 */
describe('local_vaults device/org migration repair (SEC-026)', () => {
  const MIGRATION = '2026-10-15-160110-local-vault-device-org-fk.sql';
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

  const notices: string[] = [];
  const replaySql = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (n) => { notices.push(String(n.message)); },
  });
  afterAll(async () => { await replaySql.end({ timeout: 5 }); });

  async function replay(): Promise<string> {
    notices.length = 0;
    await replaySql.unsafe(migrationSql);
    return notices.find((m) => m.includes('SEC-026 cleanup')) ?? '';
  }

  it('restamps and deactivates a mismatched vault, restamps its inventory, and re-applies as a no-op', async () => {
    const admin = getTestDb() as any;
    const { orgA, orgB, deviceA, deviceB } = await seed();

    // Snapshot chain lives with the device's REAL owner (orgB / deviceB).
    const [config] = await admin.insert(backupConfigs).values({
      orgId: orgB.id, name: 'sec026-cfg', type: 'file', provider: 'local', providerConfig: {},
    }).returning({ id: backupConfigs.id });
    const [job] = await admin.insert(backupJobs).values({
      orgId: orgB.id, configId: config!.id, deviceId: deviceB.id, status: 'completed', type: 'manual',
    }).returning({ id: backupJobs.id });
    const [snapshot] = await admin.insert(backupSnapshots).values({
      orgId: orgB.id, jobId: job!.id, deviceId: deviceB.id,
      snapshotId: `sec026-${randomUUID()}`, timestamp: new Date(), size: 1024,
    }).returning({ id: backupSnapshots.id });

    // Forge the pre-fix row shape: caller org A, victim device B. Only
    // possible with the constraint off — which is exactly the historical state
    // this migration repairs.
    await admin.execute(sql`ALTER TABLE local_vaults DROP CONSTRAINT IF EXISTS local_vaults_device_org_fkey`);
    let badVaultId: string;
    let inventoryId: string;
    try {
      const [badVault] = await admin.insert(localVaults).values({
        orgId: orgA.id, deviceId: deviceB.id, vaultPath: '/attacker/chosen/path', isActive: true,
      }).returning({ id: localVaults.id });
      badVaultId = badVault!.id;
      vaultIds.push(badVaultId);

      const [inventory] = await admin.insert(vaultSnapshotInventory).values({
        orgId: orgA.id, vaultId: badVaultId, snapshotDbId: snapshot!.id,
        externalSnapshotId: `ext-${randomUUID()}`,
      }).returning({ id: vaultSnapshotInventory.id });
      inventoryId = inventory!.id;

      // A same-org control that the migration must leave completely alone.
      const [goodVault] = await admin.insert(localVaults).values({
        orgId: orgA.id, deviceId: deviceA.id, vaultPath: '/legit/path', isActive: true,
      }).returning({ id: localVaults.id });
      vaultIds.push(goodVault!.id);

      const firstWarning = await replay();

      const [repaired] = await admin
        .select({ orgId: localVaults.orgId, isActive: localVaults.isActive, vaultPath: localVaults.vaultPath })
        .from(localVaults).where(eq(localVaults.id, badVaultId));
      // Restamped to the DEVICE's org, not deleted.
      expect(repaired?.orgId).toBe(orgB.id);
      // Deactivated: the attacker-chosen path must not sync under org B.
      expect(repaired?.isActive).toBe(false);
      expect(repaired?.vaultPath).toBe('/attacker/chosen/path');

      // The inventory row survived and followed its parent.
      const [inv] = await admin
        .select({ orgId: vaultSnapshotInventory.orgId })
        .from(vaultSnapshotInventory).where(eq(vaultSnapshotInventory.id, inventoryId));
      expect(inv?.orgId).toBe(orgB.id);

      // The same-org control is untouched.
      const [untouched] = await admin
        .select({ orgId: localVaults.orgId, isActive: localVaults.isActive })
        .from(localVaults).where(eq(localVaults.id, goodVault!.id));
      expect(untouched).toEqual({ orgId: orgA.id, isActive: true });

      // Counts are reported for BOTH tables, and the ids are printed.
      expect(firstWarning).toContain('restamped and deactivated 1 mismatched local vault(s)');
      expect(firstWarning).toContain('restamped 1 vault_snapshot_inventory row(s)');
      expect(firstWarning).toContain(badVaultId);
      expect(firstWarning).toContain(inventoryId);

      // Re-apply is a true no-op with zero counts.
      const secondWarning = await replay();
      expect(secondWarning).toContain('restamped and deactivated 0 mismatched local vault(s)');
      expect(secondWarning).toContain('restamped 0 vault_snapshot_inventory row(s)');

      const [afterSecond] = await admin
        .select({ orgId: localVaults.orgId, isActive: localVaults.isActive })
        .from(localVaults).where(eq(localVaults.id, badVaultId));
      expect(afterSecond).toEqual({ orgId: orgB.id, isActive: false });
    } finally {
      // The migration re-adds the constraint itself; assert it is back rather
      // than restoring it by hand, so a migration that forgot would fail here.
      const constraints = (await admin.execute(sql`
        SELECT condeferrable, condeferred, convalidated
        FROM pg_constraint
        WHERE conname = 'local_vaults_device_org_fkey' AND conrelid = 'local_vaults'::regclass
      `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; convalidated: boolean }>;
      expect(constraints).toEqual([{ condeferrable: true, condeferred: true, convalidated: true }]);
    }
  });
});
