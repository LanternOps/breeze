/**
 * The isolation proof for the custom-field importer's device resolver
 * (#3257 W06).
 *
 * Deliberately NOT an RLS assertion. `loadDeviceResolutionSnapshot` runs under
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`, where
 * `breeze_has_org_access` returns TRUE for every row — an appeal to RLS in a
 * test on this path would be a vacuous assertion. The organization and site
 * predicates carried IN THE SQL are the entire boundary, and this file is what
 * proves they are there.
 *
 * It also exercises the halves of the resolver a unit test cannot: that the
 * TypeScript normalisation (`upper(btrim(...))` / `lower(...)`) agrees with the
 * SQL the loader emits, and that a junk serial already stored by a Linux or
 * macOS agent does not group devices end to end.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { deviceHardware, devices } from '../../db/schema';
import { deviceExternalLinks } from '../../db/schema';
import {
  loadDeviceResolutionSnapshot,
  resolveDeviceRow,
  type DeviceResolutionScope,
} from '../../services/customFields/import/resolveDevice';
import type { DeviceCustomFieldImportRow } from '../../services/customFields/import/types';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let seq = 0;

async function seedDevice(input: {
  orgId: string;
  siteId: string;
  hostname: string;
  serialNumber?: string | null;
  status?: 'online' | 'offline' | 'decommissioned';
}): Promise<string> {
  seq += 1;
  const db = getTestDb();
  const [device] = await db.insert(devices).values({
    orgId: input.orgId,
    siteId: input.siteId,
    agentId: `agent-iso-${Date.now()}-${seq}`,
    hostname: input.hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
    status: input.status ?? 'offline',
  }).returning({ id: devices.id });
  if (input.serialNumber !== undefined && input.serialNumber !== null) {
    await db.insert(deviceHardware).values({
      deviceId: device!.id,
      orgId: input.orgId,
      serialNumber: input.serialNumber,
    });
  }
  return device!.id;
}

/**
 * Seeded through the TEST client and NOT inside a system DB context: the
 * partner-export statement triggers enforce a partners-before-orgs lock
 * hierarchy that a single transaction spanning two partners would violate.
 * The code under test opens its own system context.
 */
async function seedWorld() {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA!.id });
  const orgA2 = await createOrganization({ partnerId: partnerA!.id });
  const siteOne = await createSite({ orgId: orgA!.id, name: 'Site One' });
  const siteTwo = await createSite({ orgId: orgA!.id, name: 'Site Two' });
  const siteA2 = await createSite({ orgId: orgA2!.id });

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB!.id });
  const siteB = await createSite({ orgId: orgB!.id });

  const dSiteOne = await seedDevice({
    orgId: orgA!.id, siteId: siteOne!.id, hostname: 'wkstn-site-1', serialNumber: 'sn-site-1',
  });
  const dSiteTwo = await seedDevice({
    orgId: orgA!.id, siteId: siteTwo!.id, hostname: 'wkstn-site-2', serialNumber: 'sn-site-2',
  });
  const dOrgA2 = await seedDevice({
    orgId: orgA2!.id, siteId: siteA2!.id, hostname: 'wkstn-org-a2', serialNumber: 'sn-org-a2',
  });
  const dPartnerB = await seedDevice({
    orgId: orgB!.id, siteId: siteB!.id, hostname: 'wkstn-partner-b', serialNumber: 'sn-partner-b',
  });
  // Two machines that both report the same BIOS filler string, exactly as a
  // Linux or macOS agent writes it through today.
  const dJunk1 = await seedDevice({
    orgId: orgA!.id, siteId: siteOne!.id, hostname: 'wkstn-junk-1', serialNumber: 'To Be Filled By O.E.M.',
  });
  const dJunk2 = await seedDevice({
    orgId: orgA!.id, siteId: siteOne!.id, hostname: 'wkstn-junk-2', serialNumber: 'To Be Filled By O.E.M.',
  });

  await getTestDb().insert(deviceExternalLinks).values([
    {
      deviceId: dSiteOne, orgId: orgA!.id, partnerId: partnerA!.id,
      system: 'datto_rmm', externalId: 'uid-shared',
    },
    {
      deviceId: dPartnerB, orgId: orgB!.id, partnerId: partnerB!.id,
      system: 'datto_rmm', externalId: 'uid-shared',
    },
  ]);

  return {
    partnerA: partnerA!.id,
    partnerB: partnerB!.id,
    orgA: orgA!.id,
    orgA2: orgA2!.id,
    orgB: orgB!.id,
    siteOne: siteOne!.id,
    dSiteOne,
    dSiteTwo,
    dOrgA2,
    dPartnerB,
    dJunk1,
    dJunk2,
  };
}

function row(over: Partial<DeviceCustomFieldImportRow>): DeviceCustomFieldImportRow {
  return { values: [], ...over };
}

async function resolve(
  input: Partial<DeviceCustomFieldImportRow>,
  scope: DeviceResolutionScope,
) {
  const r = row(input);
  const snapshot = await loadDeviceResolutionSnapshot([r], scope);
  return resolveDeviceRow(r, snapshot);
}

describe('device resolution isolation — app layer, under a SYSTEM DB context', () => {
  runDb('a cross-partner forge is refused by the APP LAYER under a system DB context', async () => {
    const w = await seedWorld();
    const result = await resolve(
      { hostname: 'wkstn-partner-b' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(result.outcome).toBe('not-found');
    expect(result.deviceId).toBeNull();
  });

  runDb('a partner-wide caller still cannot see another partner (the partner predicate is in the SQL)', async () => {
    const w = await seedWorld();
    // accessibleOrgIds: null is SYSTEM-scope reach; only partnerId bounds it.
    const result = await resolve(
      { hostname: 'wkstn-partner-b' },
      { partnerId: w.partnerA, accessibleOrgIds: null, allowedSiteIds: null },
    );
    expect(result.outcome).toBe('not-found');
  });

  runDb('an external link is scoped to the calling partner even when the id collides', async () => {
    const w = await seedWorld();
    const mine = await resolve(
      { externalSystem: 'datto_rmm', externalId: 'uid-shared' },
      { partnerId: w.partnerA, accessibleOrgIds: null, allowedSiteIds: null },
    );
    expect(mine).toMatchObject({ outcome: 'link-match', deviceId: w.dSiteOne, method: 'link' });

    const theirs = await resolve(
      { externalSystem: 'datto_rmm', externalId: 'uid-shared' },
      { partnerId: w.partnerB, accessibleOrgIds: null, allowedSiteIds: null },
    );
    expect(theirs).toMatchObject({ outcome: 'link-match', deviceId: w.dPartnerB });
  });

  runDb('a site-restricted org user cannot resolve a device outside their sites', async () => {
    const w = await seedWorld();
    const blocked = await resolve(
      { hostname: 'wkstn-site-2' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: [w.siteOne] },
    );
    expect(blocked.outcome).toBe('not-found');

    const allowed = await resolve(
      { hostname: 'wkstn-site-1' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: [w.siteOne] },
    );
    expect(allowed).toMatchObject({ outcome: 'matched', deviceId: w.dSiteOne, method: 'hostname' });
  });

  runDb('an org outside the caller reach resolves org-not-found, never an existence oracle', async () => {
    const w = await seedWorld();
    const known = await resolve(
      { organizationId: w.orgA2, hostname: 'wkstn-org-a2' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    const unknown = await resolve(
      { organizationId: '00000000-0000-4000-8000-000000000000', hostname: 'wkstn-org-a2' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(known.outcome).toBe('org-not-found');
    expect(unknown.outcome).toBe('org-not-found');
  });

  runDb('an EMPTY reach array reaches nothing rather than degrading into "no filter"', async () => {
    const w = await seedWorld();
    const result = await resolve(
      { hostname: 'wkstn-site-1' },
      { partnerId: w.partnerA, accessibleOrgIds: [], allowedSiteIds: null },
    );
    expect(result.outcome).toBe('not-found');
  });

  runDb('resolves a real serial through the SQL the index expression covers', async () => {
    const w = await seedWorld();
    // Mixed case and padding on the row side; the stored value is lower-case.
    const result = await resolve(
      { serialNumber: '  SN-SITE-1 ' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(result).toMatchObject({ outcome: 'matched', deviceId: w.dSiteOne, method: 'serial' });
  });

  runDb('a junk serial already stored by a Linux or macOS agent never groups devices', async () => {
    const w = await seedWorld();
    const result = await resolve(
      { serialNumber: 'To Be Filled By O.E.M.' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(result.outcome).toBe('not-found');
    expect(result.candidates).toEqual([]);
  });

  runDb('refuses a row whose serial and hostname pin different devices', async () => {
    const w = await seedWorld();
    const result = await resolve(
      { serialNumber: 'sn-site-1', hostname: 'wkstn-site-2' },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(result.outcome).toBe('identity-conflict');
    expect(result.conflictingMethods).toEqual(['serial', 'hostname']);
    expect(result.deviceId).toBeNull();
  });

  runDb('a row naming an out-of-reach device id does not resolve it', async () => {
    const w = await seedWorld();
    const result = await resolve(
      { deviceId: w.dPartnerB },
      { partnerId: w.partnerA, accessibleOrgIds: [w.orgA], allowedSiteIds: null },
    );
    expect(result.outcome).toBe('not-found');
  });
});
