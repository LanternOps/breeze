import './setup';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { devices, deviceIpHistory, deviceNetwork } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { insertDevice } from './unassignedPoolFixtures';

vi.mock('../../routes/agentWs', () => ({ isAgentConnected: vi.fn(() => true), sendCommandToAgent: vi.fn(() => true) }));
vi.mock('../../services/commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(async () => ({ status: 'claimed', agentId: 'relay-agent' })),
  releaseClaimedCommandDelivery: vi.fn(),
}));
import { dispatchWake } from '../../services/wakeOnLan';

const ago = (days: number) => new Date(Date.now() - days * 86400000);
const mac = (n: number) => `AA:BB:CC:DD:EE:${n.toString(16).padStart(2, '0')}`;

describe('Wake-on-LAN MAC targeting (real Postgres)', () => {
  let orgId: string;
  let target: string;
  let rival: string;
  let foreign: string;
  let foreignOrg: string;
  let userId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id })).id;
    const site = await createSite({ orgId });
    target = (await insertDevice(orgId, site.id)).id;
    rival = (await insertDevice(orgId, site.id)).id;
    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, rival));
    foreignOrg = (await createOrganization({ partnerId: partner.id })).id;
    foreign = (await insertDevice(foreignOrg, (await createSite({ orgId: foreignOrg })).id)).id;
    userId = (await createUser({ partnerId: partner.id })).id;
  });

  async function history(deviceId: string, address: string, days: number, tenant = orgId) {
    await getTestDb().insert(deviceIpHistory).values({
      deviceId, orgId: tenant, interfaceName: address, ipAddress: '192.0.2.20',
      subnetMask: '255.255.255.0', macAddress: address, lastSeen: ago(days),
    });
  }
  async function network(deviceId: string, address: string, days: number, isPrimary = false) {
    await getTestDb().insert(deviceNetwork).values({
      deviceId, orgId, interfaceName: address, macAddress: address, updatedAt: ago(days), isPrimary,
    });
  }
  const wake = async () => {
    const prepared = await withSystemDbAccessContext(() => dispatchWake(target, userId, { relayDeviceIdOverride: rival }));
    return prepared.ok ? prepared.deliver() : prepared;
  };

  it('unions device_network with device_ip_history MACs seen within 30 days, newest first', async () => {
    await network(target, mac(1), 20, true);
    await history(target, mac(2), 5);
    await history(target, mac(3), 1);
    await history(target, mac(1).toLowerCase(), 0);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1), mac(3), mac(2)] });
  });

  it('ignores history MACs older than 30 days', async () => {
    await history(target, mac(1), 31);
    await history(target, mac(2), 29);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(2)] });
  });

  it('caps at 8 MACs after exclusions and deduplication, with device_network first', async () => {
    await network(target, mac(99), 40, true);
    for (let i = 1; i <= 12; i++) await history(target, mac(i), i);
    for (let i = 1; i <= 3; i++) await history(rival, mac(i).toLowerCase(), 0);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(99), ...Array.from({ length: 7 }, (_, i) => mac(i + 4))] });
  });

  it('keeps every live MAC and adds no history when live inventory exceeds eight', async () => {
    for (let i = 1; i <= 10; i++) await network(target, mac(i), i);
    await history(target, mac(20), 1);
    expect(await wake()).toMatchObject({ ok: true, macs: Array.from({ length: 10 }, (_, i) => mac(i + 1)) });
  });

  it.each(['network', 'history'])('excludes a history MAC another device in the org reported more recently in %s', async source => {
    await history(target, mac(1), 10);
    if (source === 'network') await network(rival, mac(1).toLowerCase(), 1);
    else await history(rival, mac(1).toLowerCase(), 1);
    expect(await wake()).toMatchObject({ ok: false, code: 'NO_MACS' });
  });

  it('keeps a device_network MAC even if another device also reports it', async () => {
    await network(target, mac(1), 10);
    await history(target, mac(1), 10);
    await network(rival, mac(1).toLowerCase(), 0);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1)] });
  });

  it('keeps history when rivals are older or equal and ignores newer sightings in another org', async () => {
    await history(target, mac(1), 1);
    await network(rival, mac(1), 2);
    await history(foreign, mac(1).toLowerCase(), 0, foreignOrg);
    const sameTime = ago(5);
    for (const deviceId of [target, rival]) {
      await getTestDb().insert(deviceIpHistory).values({ deviceId, orgId, interfaceName: 'equal', ipAddress: '192.0.2.21', macAddress: mac(2), lastSeen: sameTime });
    }
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1), mac(2)] });
  });
  it.each(['network', 'history'])('filters junk and non-unicast %s MACs before the output cap', async source => {
    const add = source === 'network' ? network : history;
    for (const address of ['junk', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:01',
      'aa:bb:cc:dd:ee:ff:00:11', 'invalid', 'aabbccddeeff', 'aa:bb-cc:dd:ee:ff']) {
      await add(target, address, 0);
    }
    await history(target, mac(1), 1);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1)] });
  });

  it('returns NO_MACS when all addresses are filtered', async () => {
    await network(target, '00:00:00:00:00:00', 0);
    await history(target, 'garbage', 0);
    expect(await wake()).toMatchObject({ ok: false, code: 'NO_MACS' });
  });

  it.each(['network', 'history'])('ignores a rival future-dated %s sighting', async source => {
    await history(target, mac(1), 1);
    await (source === 'network' ? network : history)(rival, mac(1), -1);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1)] });
  });

  it('does not count the target future-dated history as recent', async () => {
    await history(target, mac(1), -1);
    await history(target, mac(1).toLowerCase(), 31);
    expect(await wake()).toMatchObject({ ok: false, code: 'NO_MACS' });
  });

  it('allows sightings within the five-minute clock tolerance', async () => {
    await history(target, mac(1), -2 / 1440);
    expect(await wake()).toMatchObject({ ok: true, macs: [mac(1)] });
  });

  it('bounds history to the newest 32 distinct case-insensitive MACs before rival exclusion', async () => {
    for (let i = 1; i <= 40; i++) await history(target, mac(i), i / 10);
    // Duplicate sightings must not consume the candidate budget.
    for (let i = 1; i <= 10; i++) await history(target, mac(i).toLowerCase(), 20);
    for (let i = 1; i <= 28; i++) await history(rival, mac(i), 0);
    expect(await wake()).toMatchObject({ ok: true, macs: [29, 30, 31, 32].map(mac) });
  });

});
