/**
 * #9692 — auto-linking must treat a device another provider row already holds as
 * `claimed`. The candidate query's correlated EXISTS rendered
 * `x.breeze_device_id = "id"`, which bound to backup_provider_devices.id, so
 * nothing ever read as claimed. The link batch then hit the partial unique index
 * and rolled back whole, leaving every other row in it unlinked. Only real
 * Postgres shows that.
 */
import './setup';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { backupProviderConnections, backupProviderCustomers, backupProviderDevices } from '../../db/schema';
import { matchProviderDevices } from '../../services/backupProviders/deviceMatching';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;

async function connectionFor(partnerId: string, orgId: string, label: string) {
  const [connection] = await admin().insert(backupProviderConnections).values({
    partnerId, provider: 'cove', name: `Cove ${label}`, credentialsEncrypted: 'enc:test',
    vendorRootId: label, vendorRootName: 'Root',
  }).returning({ id: backupProviderConnections.id });
  const [customer] = await admin().insert(backupProviderCustomers).values({
    connectionId: connection.id, partnerId, vendorCustomerId: `vendor-${label}`,
    vendorCustomerName: `Customer ${label}`, orgId, mappingSource: 'manual',
  }).returning({ id: backupProviderCustomers.id });
  return { connectionId: connection.id, customerId: customer.id };
}

describe('matchProviderDevices claimed candidates', () => {
  it('skips a device held by another connection and still links the rest of the batch', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const claimedDevice = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'held-host' });
    const freeDevice = await createDevice({ orgId: org.id, siteId: site.id, hostname: 'free-host' });

    const holder = await connectionFor(partner.id, org.id, 'holder');
    const syncing = await connectionFor(partner.id, org.id, 'syncing');

    const row = (conn: { connectionId: string; customerId: string }, name: string, over = {}) => ({
      connectionId: conn.connectionId, partnerId: partner.id, orgId: org.id, customerId: conn.customerId,
      provider: 'cove', vendorDeviceId: `vd-${conn.connectionId}-${name}`, vendorDeviceName: name,
      accountType: 'backup_manager', ...over,
    });
    await admin().insert(backupProviderDevices).values(
      row(holder, 'held-host', { breezeDeviceId: claimedDevice.id, deviceMatchSource: 'manual' }),
    );
    const [wantsHeld, wantsFree] = await admin().insert(backupProviderDevices).values([
      row(syncing, 'held-host'),
      row(syncing, 'free-host'),
    ]).returning({ id: backupProviderDevices.id });

    const result = await withSystemDbAccessContext(() =>
      db.transaction((tx) => matchProviderDevices(tx, syncing.connectionId)),
    );

    const linkOf = async (id: string) => {
      const [found] = await admin()
        .select({ breezeDeviceId: backupProviderDevices.breezeDeviceId })
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.id, id));
      return found.breezeDeviceId;
    };
    expect(await linkOf(wantsFree.id)).toBe(freeDevice.id);
    expect(await linkOf(wantsHeld.id)).toBeNull();
    expect(result).toEqual({ linked: 1, ambiguous: 1 });
  });
});
