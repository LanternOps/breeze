import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, portalBranding, softwareInventory } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { softwareInventoryDevicePage, softwareInventorySummary } from '../../services/portal/softwareInventoryReadModel';

const NOW = new Date('2026-10-10T04:00:00Z');
const args = { page: 1, limit: 50, now: NOW };
function context(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}
async function seed(orgId: string, siteId: string, marker: string) {
  const db = getTestDb();
  const [device] = await db.insert(devices).values({
    orgId, siteId, agentId: randomUUID().replace(/-/g, ''), hostname: marker, osType: 'linux',
    osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  await db.insert(softwareInventory).values({
    orgId, deviceId: device!.id, name: marker, version: '1', vendor: 'Vendor',
    installDate: '2026-10-01', lastSeen: NOW, installLocation: 'SECRET-PATH',
    uninstallString: 'SECRET-COMMAND', fileHash: 'SECRET-HASH', hashAlgorithm: 'sha256', isManaged: true,
  });
  return device!.id;
}
describe('W04 software inventory real PostgreSQL isolation', () => {
  it('replays the DDL idempotently and defaults existing and new rows to false', async () => {
    const migration = readFileSync(new URL('../../../migrations/2026-12-20-230200-portal-software-inventory-flag.sql', import.meta.url), 'utf8');
    await getTestDb().transaction(async (tx) => {
      // Transaction-local shadow: never changes the real portal_branding table.
      await tx.execute(sql.raw('CREATE TEMP TABLE portal_branding (id integer PRIMARY KEY) ON COMMIT DROP'));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (1)'));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (2)'));
      const rows = await tx.execute(sql.raw('SELECT enable_software_inventory FROM portal_branding ORDER BY id'));
      expect(Array.from(rows)).toEqual([{ enable_software_inventory: false }, { enable_software_inventory: false }]);
    });
  });
  it('isolates both organizations, honors pagination and emits only permitted fields', async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const sa = await createSite({ orgId: a.id }); const sb = await createSite({ orgId: b.id });
    const da = await seed(a.id, sa.id, 'ORG-A'); const db = await seed(b.id, sb.id, 'ORG-B');
    // The organization summary deduplicates the same software across devices.
    const secondDeviceA = await seed(a.id, sa.id, 'ORG-A');
    await getTestDb().insert(softwareInventory).values({
      orgId: a.id, deviceId: da, name: 'ORG-A', version: '1', vendor: 'Vendor',
      installDate: '2026-10-02', lastSeen: new Date('2026-10-11T04:00:00Z'),
    });
    const ca = context(a.id, partner.id); const cb = context(b.id, partner.id);
    const summary = await withDbAccessContext(ca, () => softwareInventorySummary(a.id, args));
    expect(summary.data).toEqual([{ name: 'ORG-A', version: '1', vendor: 'Vendor', installDate: '2026-10-01', lastSeen: '2026-10-11T04:00:00.000Z' }]);
    expect(summary.pagination.total).toBe(1);
    const page = await withDbAccessContext(ca, () => softwareInventoryDevicePage(a.id, da, args));
    expect(Object.keys(page!.data[0]!).sort()).toEqual(['installDate', 'lastSeen', 'name', 'vendor', 'version']);
    expect(page!.pagination.total).toBe(2);
    const secondDevicePage = await withDbAccessContext(ca, () => softwareInventoryDevicePage(a.id, secondDeviceA, args));
    expect(secondDevicePage!.pagination.total).toBe(1);
    expect(secondDevicePage!.data[0]!.name).toBe('ORG-A');
    expect(JSON.stringify({ summary, page })).not.toContain('SECRET');
    expect(JSON.stringify({ summary, page })).not.toContain('ORG-B');
    expect(await withDbAccessContext(ca, () => softwareInventoryDevicePage(a.id, db, args))).toBeNull();
    expect(await withDbAccessContext(cb, () => softwareInventoryDevicePage(b.id, da, args))).toBeNull();
    expect((await withDbAccessContext(ca, () => softwareInventorySummary(b.id, args))).data).toEqual([]);
    expect(await withDbAccessContext(ca, () => softwareInventoryDevicePage(b.id, db, args))).toBeNull();
    expect((await withDbAccessContext(cb, () => softwareInventorySummary(b.id, args))).data[0]!.name).toBe('ORG-B');
    const emptyPage = await withDbAccessContext(ca, () => softwareInventoryDevicePage(a.id, da, { ...args, page: 3, limit: 1 }));
    expect(emptyPage!.data).toEqual([]); expect(emptyPage!.dataStatus).toBe('ok');
  });
  it('walks grouped summary pages without repeats or omissions across tied names and nullable keys', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const firstDevice = await seed(org.id, site.id, 'Example');
    const secondDevice = await seed(org.id, site.id, 'Example');
    // Every name ties; version and vendor (including NULLS LAST) distinguish
    // the groups. Duplicate each tuple across devices to guard deduplication.
    const groups = [
      { name: 'Example', version: '1', vendor: 'A' },
      { name: 'Example', version: '1', vendor: 'Vendor' },
      { name: 'Example', version: '1', vendor: null },
      { name: 'Example', version: '2', vendor: 'Vendor' },
      { name: 'Example', version: null, vendor: 'Vendor' },
      { name: 'Example', version: null, vendor: null },
    ];
    const latest = new Date('2026-10-11T04:00:00Z');
    await getTestDb().insert(softwareInventory).values([...groups].reverse().flatMap((group) => [
      { ...group, orgId: org.id, deviceId: firstDevice, installDate: '2026-09-30', lastSeen: NOW },
      { ...group, orgId: org.id, deviceId: secondDevice, installDate: '2026-10-02', lastSeen: latest },
    ]));
    const expected = groups.map((group) => ({
      ...group, installDate: '2026-09-30', lastSeen: latest.toISOString(),
    }));
    const orgContext = context(org.id, partner.id);
    for (const limit of [1, 2]) {
      const walked = [];
      for (let page = 1; page <= Math.ceil(groups.length / limit); page++) {
        const result = await withDbAccessContext(orgContext, () =>
          softwareInventorySummary(org.id, { ...args, page, limit }));
        expect(result.pagination).toEqual({ page, limit, total: groups.length });
        expect(result.data).toEqual(expected.slice((page - 1) * limit, page * limit));
        walked.push(...result.data);
      }
      expect(walked).toEqual(expected);
      const beyond = await withDbAccessContext(orgContext, () =>
        softwareInventorySummary(org.id, { ...args, page: Math.ceil(groups.length / limit) + 1, limit }));
      expect(beyond.data).toEqual([]);
      expect(beyond.pagination.total).toBe(groups.length);
      expect(beyond.dataStatus).toBe('ok');
    }
  });
  it('defaults the visibility flag to false for new portal settings', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [row] = await getTestDb().insert(portalBranding).values({ orgId: org.id }).returning();
    expect(row!.enableSoftwareInventory).toBe(false);
  });
});
