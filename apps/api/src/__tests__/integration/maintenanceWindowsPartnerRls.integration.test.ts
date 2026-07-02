/**
 * maintenance_windows RLS — dual-axis (org OR partner) enforcement
 * (#2131, epic #2135).
 *
 * Migration under test: 2026-07-01-maintenance-windows-partner-ownership.sql.
 *
 * A maintenance window is owned by EITHER an org (org_id set, partner_id
 * NULL) OR a partner (partner_id set, org_id NULL — partner-wide / "all
 * orgs"). maintenance_occurrences stay window-join; their EXISTS policies
 * gained the partner branch in the same migration. Same dual-axis
 * contract-test blindspot as the sibling suites: this functional test through
 * the REAL postgres.js driver (breeze_app role) is the guard that a partner
 * cannot forge a partner_id for another partner.
 *
 * The second describe block proves the enforcement fan-out (#1724 trap): the
 * standalone window checks previously filtered
 * maintenance_windows.org_id = device.org_id, so a stored partner-wide window
 * would silently never suppress anything.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, maintenanceOccurrences, maintenanceWindows, sites } from '../../db/schema';
import { isDeviceInMaintenance } from '../../services/maintenanceService';
import { isDeviceInMaintenanceWindow } from '../../services/deploymentEngine';
import { createOrganization, createPartner } from './db-utils';

const createdWindows: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdWindows.length === 0 && createdDevices.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdWindows) {
      await db.delete(maintenanceOccurrences).where(eq(maintenanceOccurrences.windowId, id));
      await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  createdWindows.length = 0;
  createdDevices.length = 0;
  createdSites.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const HOUR_MS = 60 * 60 * 1000;

function baseWindow(): {
  name: string;
  startTime: Date;
  endTime: Date;
  targetType: string;
  suppressAlerts: boolean;
  suppressPatching: boolean;
  status: 'scheduled';
} {
  const now = Date.now();
  return {
    name: 'Partner-wide patch night',
    startTime: new Date(now - HOUR_MS),
    endTime: new Date(now + HOUR_MS),
    targetType: 'all',
    suppressAlerts: true,
    suppressPatching: true,
    status: 'scheduled',
  };
}

async function seedPartnerWindow(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(maintenanceWindows)
      .values({ ...baseWindow(), orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdWindows.push(id);
  return id;
}

describe('maintenance_windows RLS — dual-axis (2026-07-01 migration)', () => {
  it('partner scope can INSERT a partner-wide window (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(maintenanceWindows)
        .values({ ...baseWindow(), orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdWindows.push(rows[0].id);
  });

  it('a different partner can neither see nor forge a window attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerWindow(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: maintenanceWindows.id }).from(maintenanceWindows).where(eq(maintenanceWindows.id, id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(maintenanceWindows)
          .values({ ...baseWindow(), name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide window owned by its partner (suppression still applies via workers)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerWindow(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: maintenanceWindows.id }).from(maintenanceWindows).where(eq(maintenanceWindows.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('occurrences of a partner-owned window are visible to the owning partner (window-join partner branch)', async () => {
    const partner = await createPartner();
    const windowId = await seedPartnerWindow(partner.id);

    // System (route/worker) writes the occurrence, as generateOccurrences does.
    const [occurrence] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(maintenanceOccurrences)
        .values({
          windowId,
          startTime: new Date(Date.now() - HOUR_MS),
          endTime: new Date(Date.now() + HOUR_MS),
          status: 'scheduled',
        })
        .returning(),
    );
    expect(occurrence).toBeTruthy();

    const visibleToPartner = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: maintenanceOccurrences.id })
        .from(maintenanceOccurrences)
        .where(eq(maintenanceOccurrences.windowId, windowId)),
    );
    expect(visibleToPartner.map((r) => r.id)).toContain(occurrence!.id);
  });

  it('the one-owner CHECK rejects a window that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(maintenanceWindows)
          .values({ ...baseWindow(), name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(maintenanceWindows)
          .values({ ...baseWindow(), name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide window', async () => {
    const partner = await createPartner();
    const id = await seedPartnerWindow(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(maintenanceWindows)
        .set({ name: 'Renamed window', status: 'cancelled' })
        .where(eq(maintenanceWindows.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe('cancelled');

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdWindows.splice(createdWindows.indexOf(id), 1);
  });
});

// ============================================================
// Enforcement fan-out (#2131): the load-bearing SQL that makes a stored
// partner-wide window actually SUPPRESS. Both standalone checks previously
// filtered maintenance_windows.org_id = device.org_id, silently missing
// org_id NULL rows — the #1724 trap.
// ============================================================

describe('maintenance enforcement — partner-wide window fan-out (#2131)', () => {
  async function seedDevice(orgId: string, hostname: string): Promise<string> {
    const [site] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(sites).values({ orgId, name: 'HQ' }).returning(),
    );
    createdSites.push(site!.id);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(devices)
        .values({
          orgId,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname,
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning(),
    );
    createdDevices.push(device!.id);
    return device!.id;
  }

  it("a partner-wide window suppresses devices in a member org; a FOREIGN partner's window does not", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const deviceA = await seedDevice(orgA.id, 'mw-fanout-a');
    const deviceB = await seedDevice(orgB.id, 'mw-fanout-b');

    // Active NOW; targetType 'all' satisfies maintenanceService's 'all'
    // branch, and the explicit deviceIds (deliberately including the FOREIGN
    // device) satisfy deploymentEngine's array-overlap match — so for both
    // checks, only the ownership predicate decides, which is exactly what
    // this test proves.
    const windowRows = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(maintenanceWindows)
        .values({
          ...baseWindow(),
          deviceIds: [deviceA, deviceB],
          orgId: null,
          partnerId: partnerA.id,
        })
        .returning(),
    );
    createdWindows.push(windowRows[0]!.id);

    // Workers evaluate under system context (RLS bypass) — mirror that.
    const statusA = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenance(deviceA));
    expect(statusA.active).toBe(true); // partner-wide window covers the member-org device
    expect(statusA.source).toBe('standalone');
    expect(statusA.suppressPatching).toBe(true);

    const statusB = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenance(deviceB));
    expect(statusB.active).toBe(false); // another partner's window NEVER matches

    // deploymentEngine's independent check agrees.
    const inWindowA = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenanceWindow(deviceA));
    expect(inWindowA).toBe(true);
    const inWindowB = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenanceWindow(deviceB));
    expect(inWindowB).toBe(false);
  });

  it('an org-owned window still suppresses only its own org (unchanged shape)', async () => {
    const partner = await createPartner();
    const org1 = await createOrganization({ partnerId: partner.id });
    const org2 = await createOrganization({ partnerId: partner.id });

    const device1 = await seedDevice(org1.id, 'mw-org-1');
    const device2 = await seedDevice(org2.id, 'mw-org-2');

    const rows = await withDbAccessContext(orgContext(org1.id), () =>
      db
        .insert(maintenanceWindows)
        .values({ ...baseWindow(), name: 'Org-owned window', orgId: org1.id, partnerId: null })
        .returning(),
    );
    createdWindows.push(rows[0]!.id);

    const status1 = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenance(device1));
    expect(status1.active).toBe(true);

    const status2 = await withDbAccessContext(SYSTEM_CTX, () => isDeviceInMaintenance(device2));
    expect(status2.active).toBe(false);
  });
});
