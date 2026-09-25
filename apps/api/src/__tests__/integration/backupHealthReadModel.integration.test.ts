import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDevices,
  devices,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { listBackupHealthRows, summarizeBackupHealth } from '../../services/backupHealthReadModel';

// Three claims that only a real database and real policies can settle:
//   1. an ORG token reads its provider device rows while the partner-axis
//      connection row stays invisible — and the rows are NOT marked stale;
//   2. a site-restricted caller loses unlinked provider rows entirely;
//   3. a device that is both first-party backed up and provider-linked yields
//      two rows and ONE endpoint in the summary; the unlinked provider device
//      counts as providerOnly; a device with no jobs is never dropped — but a
//      provider-linked device with no jobs is represented by its provider row
//      alone, not also by a `no_backups` placeholder (sweep D11).
//
// Everything above is a LEFT JOIN interacting with RLS, which a Drizzle mock
// asserts the shape of but can never actually exercise.

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const unique = randomUUID().slice(0, 8);
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `backup-health-rm-${unique}@example.com`,
    });

    // Admin handle for `devices`: its partner-export insert trigger takes
    // partner locks that refuse inside an app-role seed transaction (same
    // reason backupProviderRls's seedTenant uses getTestDb() for devices).
    const testDb = getTestDb() as typeof db;
    const [deviceOne] = await testDb
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site!.id,
        agentId: randomUUID(),
        hostname: `bh-rm-one-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });
    const [deviceTwo] = await testDb
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site!.id,
        agentId: randomUUID(),
        hostname: `bh-rm-two-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id });

    const [config] = await db
      .insert(backupConfigs)
      .values({
        orgId: org.id,
        name: `bh-rm config ${unique}`,
        type: 'file',
        provider: 'local',
        providerConfig: {},
      })
      .returning({ id: backupConfigs.id });

    await db.insert(backupJobs).values({
      orgId: org.id,
      configId: config!.id,
      deviceId: deviceOne!.id,
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      totalSize: 1024,
    });

    const [connection] = await db
      .insert(backupProviderConnections)
      .values({
        partnerId: partner.id,
        provider: 'cove',
        name: `Cove bh-rm ${unique}`,
        credentialsEncrypted: 'enc:test',
        vendorRootId: '1000',
        vendorRootName: 'RootPartner',
      })
      .returning({ id: backupProviderConnections.id });

    const [customer] = await db
      .insert(backupProviderCustomers)
      .values({
        connectionId: connection!.id,
        partnerId: partner.id,
        vendorCustomerId: `vendor-${unique}`,
        vendorCustomerName: `Customer ${unique}`,
        orgId: org.id,
        mappingSource: 'manual',
      })
      .returning({ id: backupProviderCustomers.id });

    // Linked provider row — same device as the first-party job, so this
    // device carries evidence from BOTH sources.
    await db.insert(backupProviderDevices).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: org.id,
      customerId: customer!.id,
      provider: 'cove',
      vendorDeviceId: `vd-linked-${unique}`,
      vendorDeviceName: 'BH-RM-LINKED',
      breezeDeviceId: deviceOne!.id,
      status: 'completed',
      lastSuccessAt: new Date(),
      lastSessionAt: new Date(),
    });

    // Unlinked provider row — a vendor endpoint Breeze doesn't manage.
    await db.insert(backupProviderDevices).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: org.id,
      customerId: customer!.id,
      provider: 'cove',
      vendorDeviceId: `vd-unlinked-${unique}`,
      vendorDeviceName: 'BH-RM-UNLINKED',
      breezeDeviceId: null,
      status: 'completed',
      lastSuccessAt: new Date(),
      lastSessionAt: new Date(),
    });

    const orgContext: DbAccessContext = {
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: user.id,
    };
    const partnerContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [partner.id],
      userId: user.id,
    };

    return { partner, org, site: site!, user, deviceOneId: deviceOne!.id, deviceTwoId: deviceTwo!.id, orgContext, partnerContext };
  });
}

describe('backupHealthReadModel against real policies', () => {
  runDb('an org token sees its provider rows and treats the invisible connection as fresh', async () => {
    const fx = await seedFixture();
    await withDbAccessContext(fx.orgContext, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [fx.org.id] }, { page: { limit: 50 } });
      const providerRow = rows.find((r) => r.source === 'provider' && r.deviceId === fx.deviceOneId);
      expect(providerRow).toBeDefined();
      // The connection row itself is partner-axis and must NOT be readable
      // under an org token — treated as active/fresh, not stale.
      expect(providerRow!.stale).toBe(false);
      expect(providerRow!.health).not.toBe('unknown');
    });
  });

  runDb('a site-restricted caller loses unlinked provider rows', async () => {
    const fx = await seedFixture();
    await withDbAccessContext(fx.orgContext, async () => {
      const { rows } = await listBackupHealthRows(
        { orgIds: [fx.org.id], siteIds: [fx.site.id] },
        { page: { limit: 50 } },
      );
      expect(rows.filter((r) => r.source === 'provider' && r.deviceId === null)).toEqual([]);
      expect(rows.some((r) => r.source === 'provider' && r.deviceId === fx.deviceOneId)).toBe(true);
    });
  });

  runDb('emits two rows and one endpoint for a dual-source device', async () => {
    const fx = await seedFixture();
    await withDbAccessContext(fx.partnerContext, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [fx.org.id] }, { page: { limit: 50 } });
      expect(rows.filter((r) => r.deviceId === fx.deviceOneId)).toHaveLength(2);
      const summary = await summarizeBackupHealth({ orgIds: [fx.org.id] });
      expect(summary.endpoints.total).toBe(2); // two devices, not three rows
      expect(summary.providerOnly).toBe(1); // the unlinked vendor endpoint
    });
  });

  // D11 (sweep v0.116.0): a provider-linked device with NO first-party jobs
  // must not also surface a Breeze-leg `no_backups` placeholder row — the
  // provider row already represents it. Contrast with the dual-source test
  // above, where the first-party job is real evidence and keeps its own row.
  runDb('a provider-linked device without first-party jobs yields only its provider row', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(async () => {
      const [connection] = await db
        .select({ id: backupProviderDevices.connectionId, customerId: backupProviderDevices.customerId })
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.breezeDeviceId, fx.deviceOneId));
      await db.insert(backupProviderDevices).values({
        connectionId: connection!.id,
        partnerId: fx.partner.id,
        orgId: fx.org.id,
        customerId: connection!.customerId,
        provider: 'cove',
        vendorDeviceId: `vd-linked-two-${randomUUID().slice(0, 8)}`,
        vendorDeviceName: 'BH-RM-LINKED-TWO',
        breezeDeviceId: fx.deviceTwoId,
        status: 'completed',
        lastSuccessAt: new Date(),
        lastSessionAt: new Date(),
      });
    });
    await withDbAccessContext(fx.partnerContext, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [fx.org.id] }, { page: { limit: 50 } });
      const forTwo = rows.filter((r) => r.deviceId === fx.deviceTwoId);
      expect(forTwo).toHaveLength(1);
      expect(forTwo[0]!.source).toBe('provider');
      const summary = await summarizeBackupHealth({ orgIds: [fx.org.id] });
      expect(summary.byStatus.no_backups).toBe(0);
      expect(summary.endpoints.total).toBe(2);
    });
  });

  runDb('never drops a device that has no backup jobs', async () => {
    const fx = await seedFixture();
    await withDbAccessContext(fx.partnerContext, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [fx.org.id] }, { page: { limit: 50 } });
      expect(rows.some((r) => r.deviceId === fx.deviceTwoId && r.status === 'no_backups')).toBe(true);
    });
  });
});
