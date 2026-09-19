/**
 * Real-Postgres proof for m365Sync/links.ts (spec §5.6). The reconciliation is
 * two set-based statements with several data-modifying CTEs and 1:1 guards on
 * BOTH sides; a Drizzle mock can only assert that some SQL was sent. Everything
 * asserted here — case/whitespace folding, the ambiguity skip, the hostname
 * fallback, relink on mismatch, releasing a stale claim, and org isolation — is
 * a property of the SQL itself, executed as breeze_app under a system context.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so memoized fixtures would be stale and vacuous.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { deviceHardware, devices, m365IntuneDevices } from '../../db/schema';
import { reconcileDeviceLinks } from '../../services/m365Sync/links';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let orgId: string;
let siteId: string;
let seq = 0;

async function seedBreezeDevice(
  hostname: string,
  serial: string | null,
  opts: { org?: string; site?: string; status?: 'online' | 'decommissioned'; ephemeral?: boolean } = {},
): Promise<string> {
  seq += 1;
  const org = opts.org ?? orgId;
  const [device] = await getTestDb().insert(devices).values({
    orgId: org, siteId: opts.site ?? siteId,
    agentId: `agent-m365-link-${Date.now()}-${seq}`,
    hostname, osType: 'windows', osVersion: '11',
    architecture: 'x64', agentVersion: '1.0.0',
    status: opts.status ?? 'online',
    isEphemeral: opts.ephemeral ?? false,
  }).returning({ id: devices.id });
  await getTestDb().insert(deviceHardware).values({ deviceId: device!.id, orgId: org, serialNumber: serial });
  return device!.id;
}

async function seedIntuneRow(input: {
  deviceName: string; serialNumber: string | null; breezeDeviceId?: string | null; isStale?: boolean;
}): Promise<string> {
  seq += 1;
  const [row] = await getTestDb().insert(m365IntuneDevices).values({
    orgId,
    graphId: `graph-${Date.now()}-${seq}`,
    deviceName: input.deviceName,
    serialNumber: input.serialNumber,
    complianceState: 'compliant',
    coreHash: 'f'.repeat(64),
    breezeDeviceId: input.breezeDeviceId ?? null,
    isStale: input.isStale ?? false,
  }).returning({ id: m365IntuneDevices.id });
  return row!.id;
}

async function linkOf(id: string): Promise<string | null> {
  const [row] = await getTestDb().select({ link: m365IntuneDevices.breezeDeviceId })
    .from(m365IntuneDevices).where(eq(m365IntuneDevices.id, id));
  return row?.link ?? null;
}

const reconcile = () => withSystemDbAccessContext(() => reconcileDeviceLinks(orgId));

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  orgId = org!.id;
  siteId = (await createSite({ orgId }))!.id;
});

describe('m365Sync device link reconciliation (real Postgres)', () => {
  runDb('links a 1:1 serial match, case- and whitespace-insensitively', async () => {
    const deviceId = await seedBreezeDevice('WS-001', '  abc-123  ');
    const intuneId = await seedIntuneRow({ deviceName: 'somethingelse', serialNumber: 'ABC-123' });

    const out = await reconcile();

    expect(out).toEqual({ linkedBySerial: 1, linkedByHostname: 0, ambiguous: 0 });
    expect(await linkOf(intuneId)).toBe(deviceId);
  });

  runDb('skips and counts a serial duplicated on the Breeze side', async () => {
    await seedBreezeDevice('WS-001', 'DUP-1');
    await seedBreezeDevice('WS-002', 'dup-1');
    const intuneId = await seedIntuneRow({ deviceName: 'WS-999', serialNumber: 'DUP-1' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.ambiguous).toBe(1);
    expect(await linkOf(intuneId)).toBeNull();
  });

  runDb('skips and counts a serial duplicated on the Intune side', async () => {
    await seedBreezeDevice('WS-001', 'DUP-2');
    const a = await seedIntuneRow({ deviceName: 'A', serialNumber: 'DUP-2' });
    const b = await seedIntuneRow({ deviceName: 'B', serialNumber: 'dup-2' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.ambiguous).toBe(1);
    expect(await linkOf(a)).toBeNull();
    expect(await linkOf(b)).toBeNull();
  });

  runDb('a decommissioned twin does not make a re-enrolled machine ambiguous', async () => {
    await seedBreezeDevice('WS-OLD', 'REENROLL-1', { status: 'decommissioned' });
    const live = await seedBreezeDevice('WS-NEW', 'REENROLL-1');
    await seedBreezeDevice('QS-1', 'REENROLL-1', { ephemeral: true });
    const intuneId = await seedIntuneRow({ deviceName: 'x', serialNumber: 'REENROLL-1' });

    const out = await reconcile();

    expect(out).toMatchObject({ linkedBySerial: 1, ambiguous: 0 });
    expect(await linkOf(intuneId)).toBe(live);
  });

  runDb('falls back to a 1:1 hostname match when serials are absent', async () => {
    const deviceId = await seedBreezeDevice('ws-fallback', null);
    const intuneId = await seedIntuneRow({ deviceName: 'WS-Fallback', serialNumber: null });

    const out = await reconcile();

    expect(out).toEqual({ linkedBySerial: 0, linkedByHostname: 1, ambiguous: 0 });
    expect(await linkOf(intuneId)).toBe(deviceId);
  });

  runDb('does not claim by hostname a device another Intune row already owns', async () => {
    const deviceId = await seedBreezeDevice('WS-SHARED', 'SER-1');
    const bySerial = await seedIntuneRow({ deviceName: 'unrelated', serialNumber: 'SER-1' });
    const byHostname = await seedIntuneRow({ deviceName: 'WS-SHARED', serialNumber: null });

    const out = await reconcile();

    expect(await linkOf(bySerial)).toBe(deviceId);
    expect(await linkOf(byHostname)).toBeNull();
    expect(out.linkedByHostname).toBe(0);
  });

  runDb('releases a stale hostname claim when the serial pass gives the device to another row', async () => {
    const deviceId = await seedBreezeDevice('WS-TAKEN', 'SER-TAKEN');
    const staleClaim = await seedIntuneRow({ deviceName: 'WS-TAKEN', serialNumber: null, breezeDeviceId: deviceId });
    const owner = await seedIntuneRow({ deviceName: 'other', serialNumber: 'SER-TAKEN' });

    await reconcile();

    expect(await linkOf(owner)).toBe(deviceId);
    expect(await linkOf(staleClaim)).toBeNull();
  });

  runDb('re-links a row whose stored link no longer matches its serial', async () => {
    const oldDevice = await seedBreezeDevice('WS-OLD', 'OLD-SERIAL');
    const newDevice = await seedBreezeDevice('WS-NEW', 'NEW-SERIAL');
    const intuneId = await seedIntuneRow({ deviceName: 'WS-NEW', serialNumber: 'NEW-SERIAL', breezeDeviceId: oldDevice });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(1);
    expect(await linkOf(intuneId)).toBe(newDevice);
  });

  runDb('is idempotent: a second pass writes nothing', async () => {
    await seedBreezeDevice('WS-IDEM', 'IDEM-1');
    await seedIntuneRow({ deviceName: 'WS-IDEM', serialNumber: 'IDEM-1' });

    await reconcile();
    expect(await reconcile()).toEqual({ linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0 });
  });

  runDb('never touches last_changed_at or core_hash', async () => {
    await seedBreezeDevice('WS-TS', 'TS-1');
    const intuneId = await seedIntuneRow({ deviceName: 'x', serialNumber: 'TS-1' });
    const [before] = await getTestDb().select().from(m365IntuneDevices).where(eq(m365IntuneDevices.id, intuneId));

    await reconcile();

    const [after] = await getTestDb().select().from(m365IntuneDevices).where(eq(m365IntuneDevices.id, intuneId));
    expect(after!.breezeDeviceId).not.toBeNull();
    expect(after!.lastChangedAt).toEqual(before!.lastChangedAt);
    expect(after!.coreHash).toBe(before!.coreHash);
  });

  runDb('ignores stale Intune rows and empty/whitespace serials', async () => {
    await seedBreezeDevice('WS-STALE', 'STALE-1');
    const stale = await seedIntuneRow({ deviceName: 'WS-STALE', serialNumber: 'STALE-1', isStale: true });
    await seedBreezeDevice('WS-BLANK', '   ');
    const blank = await seedIntuneRow({ deviceName: 'nope', serialNumber: '   ' });

    const out = await reconcile();

    expect(await linkOf(stale)).toBeNull();
    expect(await linkOf(blank)).toBeNull();
    expect(out.linkedBySerial).toBe(0);
  });

  runDb('never links across organizations', async () => {
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner!.id });
    const otherSite = await createSite({ orgId: otherOrg!.id });
    await seedBreezeDevice('WS-CROSS', 'CROSS-1', { org: otherOrg!.id, site: otherSite!.id });
    const intuneId = await seedIntuneRow({ deviceName: 'WS-CROSS', serialNumber: 'CROSS-1' });

    const out = await reconcile();

    expect(out).toEqual({ linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0 });
    expect(await linkOf(intuneId)).toBeNull();
  });
});
