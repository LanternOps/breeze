/**
 * Real-DB test for the #7971 repair migration: restore `server` on devices that
 * network discovery demoted before #8034.
 *
 * The test replays the SHIPPED migration file, not a hand copy, so what it
 * pins is what every install runs at upgrade: which rows the predicate picks,
 * that both role columns flip, that the audit row lands with the device, that
 * the partner/org pre-locks hold across several partners (the #5239 outage
 * class), and that a re-run is a no-op.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite, createDevice } from './db-utils';
import { auditLogs, devices } from '../../db/schema';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-12-25-100100-repair-discovery-demoted-server-roles.sql',
);

const WINDOWS_SERVER = 'Microsoft Windows Server 2019 Standard';
const WINDOWS_DATACENTER = 'Microsoft Windows Server 2022 Datacenter';
const WINDOWS_CLIENT = 'Microsoft Windows 11 Pro 25H2';
// The agent lowercases before matching; so must the repair.
const WINDOWS_SERVER_UPPER = 'MICROSOFT WINDOWS SERVER 2016 STANDARD';

/** Replays the migration the way autoMigrate does: the whole file in one transaction. */
async function runRepairMigration(): Promise<void> {
  const migration = readFileSync(MIGRATION_FILE, 'utf8');
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw(migration));
  });
}

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { org, site };
}

async function seedDevice(
  orgId: string,
  siteId: string,
  osVersion: string,
  deviceRole: string,
  deviceRoleSource: string,
): Promise<string> {
  const { id } = await createDevice({ orgId, siteId });
  await getTestDb().execute(sql`
    UPDATE devices
    SET os_version = ${osVersion}, device_role = ${deviceRole}, device_role_source = ${deviceRoleSource}
    WHERE id = ${id}
  `);
  return id;
}

async function roleOf(id: string) {
  const [row] = await getTestDb()
    .select({ role: devices.deviceRole, source: devices.deviceRoleSource })
    .from(devices)
    .where(eq(devices.id, id));
  return row;
}

async function repairAuditsFor(ids: string[]) {
  return getTestDb()
    .select({
      resourceId: auditLogs.resourceId,
      orgId: auditLogs.orgId,
      actorType: auditLogs.actorType,
      details: auditLogs.details,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'device.role.repaired'), inArray(auditLogs.resourceId, ids)));
}

describe('#7971 repair migration: discovery-demoted server roles', () => {
  it('restores only discovery-demoted devices whose OS says server, audits each, and is idempotent', async () => {
    const { org, site } = await seedOrg();
    // A second partner, so the partner/org pre-locks cover more than one of each.
    const other = await seedOrg();

    // Demoted: discovery wrote the role, the agent's OS fact says server.
    const demoted = await seedDevice(org.id, site.id, WINDOWS_SERVER, 'workstation', 'discovery');
    const demotedDc = await seedDevice(org.id, site.id, WINDOWS_DATACENTER, 'nas', 'discovery');
    const demotedOther = await seedDevice(other.org.id, other.site.id, WINDOWS_SERVER, 'workstation', 'discovery');
    const demotedUpper = await seedDevice(org.id, site.id, WINDOWS_SERVER_UPPER, 'workstation', 'discovery');
    // Right role, wrong owner: discovery set 'server' itself, so the next scan
    // could still demote it. Only the source changes.
    const discoveryServer = await seedDevice(org.id, site.id, WINDOWS_SERVER, 'server', 'discovery');
    // Hand-set: a technician (or Fleet Design) chose this role — never touched.
    const handSet = await seedDevice(org.id, site.id, WINDOWS_SERVER, 'workstation', 'manual');
    const fleetDesign = await seedDevice(org.id, site.id, WINDOWS_SERVER, 'workstation', 'ai');
    // Ambiguous: discovery wrote it, but the OS fact does not say server.
    const ambiguous = await seedDevice(org.id, site.id, WINDOWS_CLIENT, 'workstation', 'discovery');
    // Already correct: agent-sourced server — nothing to do.
    const healthy = await seedDevice(org.id, site.id, WINDOWS_SERVER, 'server', 'auto');

    const repairedIds = [demoted, demotedDc, demotedOther, demotedUpper, discoveryServer];
    const all = [...repairedIds, handSet, fleetDesign, ambiguous, healthy];

    await runRepairMigration();

    // Both columns flip: 'auto' hands the role back to the heartbeat and puts
    // it under #8034's allowlist, so the next scan cannot demote it again.
    expect(await roleOf(demoted)).toEqual({ role: 'server', source: 'auto' });
    expect(await roleOf(demotedDc)).toEqual({ role: 'server', source: 'auto' });
    expect(await roleOf(demotedOther)).toEqual({ role: 'server', source: 'auto' });
    expect(await roleOf(demotedUpper)).toEqual({ role: 'server', source: 'auto' });
    expect(await roleOf(discoveryServer)).toEqual({ role: 'server', source: 'auto' });
    expect(await roleOf(handSet)).toEqual({ role: 'workstation', source: 'manual' });
    expect(await roleOf(fleetDesign)).toEqual({ role: 'workstation', source: 'ai' });
    expect(await roleOf(ambiguous)).toEqual({ role: 'workstation', source: 'discovery' });
    expect(await roleOf(healthy)).toEqual({ role: 'server', source: 'auto' });

    const audits = await repairAuditsFor(all);
    expect(audits.map((a) => a.resourceId).sort()).toEqual([...repairedIds].sort());
    expect(audits.find((a) => a.resourceId === discoveryServer)?.details).toMatchObject({ from: 'server', to: 'server' });
    const dcAudit = audits.find((a) => a.resourceId === demotedDc);
    expect(dcAudit?.orgId).toBe(org.id);
    expect(dcAudit?.actorType).toBe('system');
    expect(dcAudit?.details).toEqual({
      from: 'nas',
      to: 'server',
      previousSource: 'discovery',
      newSource: 'auto',
      source: 'repair-7971',
      osVersion: WINDOWS_DATACENTER,
      issue: 7971,
    });
    expect(audits.find((a) => a.resourceId === demotedOther)?.orgId).toBe(other.org.id);

    // Re-run: nothing left to repair, no new audit rows.
    await runRepairMigration();
    expect(await repairAuditsFor(all)).toHaveLength(repairedIds.length);
    expect(await roleOf(ambiguous)).toEqual({ role: 'workstation', source: 'discovery' });
  });
});
