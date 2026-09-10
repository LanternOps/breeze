/**
 * SEC-2026-09-05-026 — local_vaults must not pair one tenant's org_id with
 * another tenant's device_id. Org-axis RLS checks only the row's org_id, so a
 * composite FK is the database backstop for every present and future writer.
 */
import './setup';
import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, localVaults, organizations, partners, sites } from '../../db/schema';
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
    await admin.delete(devices).where(sql`${devices.orgId} IN (SELECT id FROM organizations WHERE partner_id IN (${ids}))`);
    await admin.delete(sites).where(sql`${sites.orgId} IN (SELECT id FROM organizations WHERE partner_id IN (${ids}))`);
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
