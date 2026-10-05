/**
 * #6012 (backup provider W04) — the customer portal's backup read model over
 * third-party rows, against real Postgres as the unprivileged app role under
 * the portal's own DB context (routes/portal/auth.ts: organization scope, no
 * partner-wide SELECT branch).
 *
 * What only a live database can prove: another org's vendor rows never reach
 * this org's portal even when the read model is handed the other org's id,
 * the vendor name stays hidden until the MSP turns the per-connection toggle
 * on (spec D5, read off the denormalized device-row column because the
 * partner-axis connection is invisible to an org token), and the dashboard
 * tile only counts third-party coverage once portal Backups is enabled.
 */
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
  portalBranding,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { backupDevicesPage, backupOverview, backupTile } from '../../services/portal/backupReadModel';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);

async function seedTenant(label: string, opts: { showVendorName: boolean; enableBackups: boolean }) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  // Admin handle for `devices` (partner-export insert trigger; same reason as
  // backupProviderRls.integration.test.ts).
  const [device] = await (getTestDb() as typeof db).insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `${label}-laptop`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });

  const [connection] = await db.insert(backupProviderConnections).values({
    partnerId: partner.id,
    provider: 'cove',
    name: `Cove ${label}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: '1000',
    vendorRootName: 'RootPartner',
    showProviderNameInPortal: opts.showVendorName,
    lastSyncAt: NOW,
  }).returning({ id: backupProviderConnections.id });

  const [customer] = await db.insert(backupProviderCustomers).values({
    connectionId: connection!.id,
    partnerId: partner.id,
    vendorCustomerId: `vendor-${label}`,
    vendorCustomerName: `Customer ${label}`,
    orgId: org.id,
    mappingSource: 'manual',
  }).returning({ id: backupProviderCustomers.id });

  const base = {
    connectionId: connection!.id,
    partnerId: partner.id,
    orgId: org.id,
    customerId: customer!.id,
    provider: 'cove',
    portalShowProviderName: opts.showVendorName,
  };
  await db.insert(backupProviderDevices).values([
    {
      ...base,
      vendorDeviceId: `vd-${label}-linked`,
      vendorDeviceName: `${label.toUpperCase()}-LAPTOP`,
      breezeDeviceId: device!.id,
      deviceMatchSource: 'manual',
      status: 'completed',
      lastSuccessAt: RECENT,
    },
    {
      ...base,
      vendorDeviceId: `vd-${label}-unlinked`,
      vendorDeviceName: `${label.toUpperCase()}-VENDOR-ONLY`,
      status: 'failed',
      lastSuccessAt: null,
    },
  ]);

  await db.insert(portalBranding).values({ orgId: org.id, enableBackups: opts.enableBackups });

  const portalContext: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: null,
  };
  return { org, site: site!, device: device!, connection: connection!, customer: customer!, base, portalContext };
}

async function seed(opts: { aShowsVendor?: boolean; aEnablesBackups?: boolean } = {}) {
  return withSystemDbAccessContext(async () => ({
    a: await seedTenant('a', { showVendorName: opts.aShowsVendor ?? false, enableBackups: opts.aEnablesBackups ?? true }),
    b: await seedTenant('b', { showVendorName: true, enableBackups: true }),
  }));
}

const pageArgs = { page: 1, limit: 100, timezone: 'UTC', now: NOW };

describe('portal backup read model over third-party rows (#6012)', () => {
  runDb('shows this org\'s linked and vendor-only rows under the generic label, and nothing of another org\'s', async () => {
    const { a } = await seed();

    const [page, overview] = await withDbAccessContext(a.portalContext, () => Promise.all([
      backupDevicesPage(a.org.id, pageArgs),
      backupOverview(a.org.id, { timezone: 'UTC', now: NOW }),
    ]));

    expect(page.data.map((row) => row.name).sort()).toEqual(['A-VENDOR-ONLY', 'a-laptop']);
    const laptop = page.data.find((row) => row.id === a.device.id)!;
    expect(laptop).toMatchObject({
      configured: true, source: 'external', status: 'completed', health: 'healthy',
      providerLabel: 'Managed cloud backup',
    });
    const vendorOnly = page.data.find((row) => row.name === 'A-VENDOR-ONLY')!;
    expect(vendorOnly).toMatchObject({ source: 'external', status: 'failed', health: 'critical', configured: true });
    expect(vendorOnly.id).toMatch(/^provider:/);
    expect(page.pagination.total).toBe(2);

    expect(overview.externalProviders).toEqual(['Managed cloud backup']);
    expect(overview.byHealth).toEqual({ healthy: 1, warning: 0, critical: 1, unknown: 0 });

    const serialized = JSON.stringify({ page, overview });
    expect(serialized).not.toContain('Cove');
    expect(serialized).not.toContain('B-');
  });

  runDb('returns nothing of another org even when handed that org\'s id (RLS, not the argument, is the fence)', async () => {
    const { a, b } = await seed();

    const [page, overview, tile] = await withDbAccessContext(a.portalContext, () => Promise.all([
      backupDevicesPage(b.org.id, pageArgs),
      backupOverview(b.org.id, { timezone: 'UTC', now: NOW }),
      backupTile(b.org.id, NOW),
    ]));

    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(overview.externalProviders).toEqual([]);
    expect(overview.byHealth).toEqual({ healthy: 0, warning: 0, critical: 0, unknown: 0 });
    expect(tile.configured).toBe(0);
    expect(JSON.stringify({ page, overview, tile })).not.toContain('Cove');
  });

  runDb('names the vendor once the MSP turns the portal-name toggle on (D5)', async () => {
    const { a } = await seed({ aShowsVendor: true });

    const page = await withDbAccessContext(a.portalContext, () => backupDevicesPage(a.org.id, pageArgs));
    expect(new Set(page.data.map((row) => row.providerLabel))).toEqual(new Set(['Cove Data Protection']));
  });

  runDb('never counts a device twice, and never an ephemeral one, when first-party and third-party backup overlap', async () => {
    const { a } = await seed();
    await withSystemDbAccessContext(async () => {
      const admin = getTestDb() as typeof db;
      const mk = async (hostname: string, isEphemeral = false) => {
        const [row] = await admin.insert(devices).values({
          orgId: a.org.id, siteId: a.site.id, agentId: randomUUID(), hostname, isEphemeral,
          osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
        }).returning({ id: devices.id });
        return row!.id;
      };
      const both = await mk('a-both');
      const inactiveCfg = await mk('a-inactive-cfg');
      const ephemeral = await mk('a-ephemeral', true);

      const [active] = await db.insert(backupConfigs).values({
        orgId: a.org.id, name: 'Active', type: 'file', provider: 'local', providerConfig: {}, isActive: true,
      }).returning({ id: backupConfigs.id });
      const [inactive] = await db.insert(backupConfigs).values({
        orgId: a.org.id, name: 'Inactive', type: 'file', provider: 'local', providerConfig: {}, isActive: false,
      }).returning({ id: backupConfigs.id });
      await db.insert(backupJobs).values([
        { orgId: a.org.id, configId: active!.id, deviceId: both, status: 'completed', startedAt: RECENT, completedAt: RECENT },
        { orgId: a.org.id, configId: inactive!.id, deviceId: inactiveCfg, status: 'completed', startedAt: RECENT, completedAt: RECENT },
      ]);
      await db.insert(backupProviderDevices).values([both, inactiveCfg, ephemeral].map((id, i) => ({
        ...a.base, vendorDeviceId: `vd-a-extra-${i}`, vendorDeviceName: `A-EXTRA-${i}`, breezeDeviceId: id,
        deviceMatchSource: 'manual' as const, status: 'completed' as const, lastSuccessAt: RECENT,
      })));
    });

    const tile = await withDbAccessContext(a.portalContext, () => backupTile(a.org.id, NOW));
    // Non-ephemeral devices: a-laptop, a-both, a-inactive-cfg. First-party
    // configured (active config): a-both. Third-party only: a-laptop and
    // a-inactive-cfg (its job is under an INACTIVE config). a-both is not
    // counted twice; the ephemeral device is not counted at all. The seeded
    // vendor-only row (A-VENDOR-ONLY) is a Backups-table row too, so it counts
    // once in both numbers (#7505): 3 managed + 1 unlinked.
    expect(tile).toMatchObject({ total: 4, configured: 4 });
    expect(tile.configured).toBeLessThanOrEqual(tile.total);
  });

  runDb('counts the third-party-backed device on the dashboard tile only while portal Backups is on', async () => {
    const { a } = await seed({ aEnablesBackups: false });

    const off = await withDbAccessContext(a.portalContext, () => backupTile(a.org.id, NOW));
    expect(off).toMatchObject({ status: 'not_configured', configured: 0, total: 1 });

    await withSystemDbAccessContext(() =>
      db.update(portalBranding).set({ enableBackups: true }).where(eq(portalBranding.orgId, a.org.id)));
    const on = await withDbAccessContext(a.portalContext, () => backupTile(a.org.id, NOW));
    // Configured, but never a claimed verification. a-laptop (linked) plus the
    // vendor-only row — the same two rows the Backups table lists (#7505).
    expect(on).toMatchObject({ status: 'no_data', configured: 2, total: 2, completedAt: null });
  });
});
