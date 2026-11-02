/**
 * Reinstall candidates (#8318 wave 2-1, spec §7.3) against real Postgres and
 * Redis: the partner-wide search by SMBIOS UUID (both byte orders), serial +
 * manufacturer and hostname; who qualifies as a target; the flag written on
 * the SOURCE only, never downgraded, never rewritten; the event, the opt-in
 * alert and the audit row on the TARGET, without the identity of a parked or
 * cross-org source; the two clears; and the wiring from enrollment and from
 * the hardware report.
 *
 * The service runs in system scope (it is a background step after commit);
 * the hardware report route runs as the request does, inside an org-scoped
 * `breeze_app` context, with the search deferred until that context commits.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  auditLogs,
  deviceHardware,
  deviceReattachments,
  devices,
  enrollmentKeys,
} from '../../db/schema';
import { processReapUninstallIntent } from '../../jobs/offlineDetector';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { inventoryRoutes } from '../../routes/agents/inventory';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { getRedis } from '../../services/redis';
import { detectReinstallCandidates } from '../../services/reinstallCandidates';
import { PARKED_SOURCE_LABEL } from '../../services/reinstallCandidates/notify';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  parkedSource,
  readDevice,
  seedAgentDevice,
  seedReattachTenant,
  silentTarget,
  type ReattachTenant,
  type SeedDeviceOptions,
} from './deviceReattachFixtures';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const UUID = '4c4c4544-0042-3510-8051-b4c04f4d3132';
/** The same board read with the SMBIOS < 2.6 byte order. */
const UUID_SWAPPED = '44454c4c-4200-1035-8051-b4c04f4d3132';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Place = { orgId: string; siteId: string };

interface Hardware {
  systemUuid?: string | null;
  serialNumber?: string | null;
  manufacturer?: string | null;
}

async function seedHardware(device: { id: string; orgId: string }, hw: Hardware): Promise<void> {
  await getTestDb().insert(deviceHardware).values({ deviceId: device.id, orgId: device.orgId, ...hw });
}

/** An older record: created 30 days ago, silent for two hours. */
async function oldTarget(place: Place, hw: Hardware, options: SeedDeviceOptions = {}) {
  const device = await silentTarget(place, options);
  await getTestDb().execute(sql`UPDATE devices SET created_at = now() - interval '30 days' WHERE id = ${device.id}::uuid`);
  await seedHardware(device, hw);
  return device;
}

/** A just-enrolled install (created and enrolled now). */
async function newSource(place: Place, hw: Hardware, options: SeedDeviceOptions = {}) {
  const device = await seedAgentDevice(place, { status: 'pending', ...options });
  await seedHardware(device, hw);
  return device;
}

async function detect(sourceDeviceId: string, trigger: 'enroll' | 'hardware_report' = 'enroll') {
  return detectReinstallCandidates({ sourceDeviceId, trigger });
}

async function flagOf(deviceId: string) {
  const row = await readDevice(deviceId);
  return {
    target: row?.possibleReplacementOfDeviceId ?? null,
    reason: row?.possibleReplacementReason ?? null,
    detectedAt: row?.possibleReplacementDetectedAt ?? null,
  };
}

async function suspectedEvents(orgId: string) {
  const stream = await getRedis()!.xrange(`breeze:events:${orgId}`, '-', '+');
  return stream
    .map(([, fields]) => JSON.parse(fields[1]!) as { type: string; orgId?: string; payload: Record<string, unknown> })
    .filter((e) => e.type === 'device.reinstall_suspected');
}

/** The built-in template (alert_templates is truncated between tests) and an org rule bound to it. */
async function enableAlertRule(orgId: string): Promise<void> {
  await replayMigration('2027-01-19-110300-device-reinstall-suspected-alert-template.sql');
  const [template] = await getTestDb().select({ id: alertTemplates.id }).from(alertTemplates)
    .where(sql`${alertTemplates.conditions}->>'eventType' = 'device.reinstall_suspected'`);
  await getTestDb().insert(alertRules).values({
    orgId,
    templateId: template!.id,
    name: `Possible reinstall ${randomUUID().slice(0, 8)}`,
    targetType: 'org',
    targetId: orgId,
  });
}

async function alertsOn(deviceId: string) {
  return getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId));
}

async function suspectedAudits(targetId: string) {
  return getTestDb().select().from(auditLogs)
    .where(and(eq(auditLogs.action, 'device.reinstall_suspected'), eq(auditLogs.resourceId, targetId)));
}

/** Audit rows are written through a retry queue: poll briefly. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 60): Promise<T> {
  let value = await read();
  for (let i = 0; i < attempts && !done(value); i += 1) {
    await sleep(50);
    value = await read();
  }
  return value;
}

describe('reinstall candidates — the search (§7.3)', () => {
  it('flags hardware on the source when a UUID matches an older silent device in another org of the partner; alert, event and audit on the target', async () => {
    const tenant = await seedReattachTenant();
    await enableAlertRule(tenant.orgA.orgId);
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });

    expect(await detect(source.id)).toMatchObject({ written: true, kind: 'new', targetDeviceId: target.id, reason: 'hardware' });
    const flag = await flagOf(source.id);
    expect(flag).toMatchObject({ target: target.id, reason: 'hardware' });
    expect(flag.detectedAt).toBeInstanceOf(Date);
    // Only the source is written.
    expect((await flagOf(target.id)).target).toBeNull();

    const events = await suspectedEvents(tenant.orgA.orgId);
    expect(events).toHaveLength(1);
    // Cross-org source: the target's org learns nothing about it.
    expect(events[0]!.payload).toEqual({
      targetDeviceId: target.id,
      reason: 'hardware',
      detectedAt: flag.detectedAt!.toISOString(),
      sourceParked: false,
    });
    expect(await suspectedEvents(tenant.orgB.orgId)).toHaveLength(0);

    const raised = await alertsOn(target.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.orgId).toBe(tenant.orgA.orgId);
    expect(JSON.stringify(raised[0])).not.toContain(source.id);
    expect(await alertsOn(source.id)).toHaveLength(0);

    const audits = await waitFor(() => suspectedAudits(target.id), (rows) => rows.length > 0);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.orgId).toBe(tenant.orgA.orgId);
    expect(audits[0]!.actorType).toBe('system');
    expect(JSON.stringify(audits[0]!.details)).not.toContain(source.id);
  });

  it('matches the SMBIOS < 2.6 byte-swapped form of the UUID', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID_SWAPPED });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: target.id, reason: 'hardware' });
  });

  it('matches serial + manufacturer alone as hardware (normalized case and spaces)', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { serialNumber: 'pf3abcde ', manufacturer: 'LENOVO' });
    const source = await newSource(tenant.orgB, { serialNumber: 'PF3ABCDE', manufacturer: ' lenovo' });
    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: target.id, reason: 'hardware' });
  });

  it('never matches a placeholder serial', async () => {
    const tenant = await seedReattachTenant();
    await oldTarget(tenant.orgA, { serialNumber: 'To Be Filled By O.E.M.', manufacturer: 'System manufacturer' });
    const source = await newSource(tenant.orgB, { serialNumber: 'To Be Filled By O.E.M.', manufacturer: 'System manufacturer' });
    expect(await detect(source.id)).toEqual({ written: false, why: 'no_candidate' });
  });

  it('matches the hostname alone (different org, same partner) as hostname, case-insensitively', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, {}, { hostname: 'FINANCE-PC-07' });
    const source = await newSource(tenant.orgB, {}, { hostname: 'finance-pc-07' });
    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: target.id, reason: 'hostname' });
    expect(await flagOf(source.id)).toMatchObject({ target: target.id, reason: 'hostname' });
  });

  it('upgrades a hostname flag to hardware on a later hardware report, and never downgrades', async () => {
    const tenant = await seedReattachTenant();
    const hostTarget = await oldTarget(tenant.orgA, {}, { hostname: 'SHOP-01' });
    const hwTarget = await oldTarget(tenant.orgA, { systemUuid: UUID }, { hostname: 'SHOP-OLD' });
    const source = await newSource(tenant.orgB, {}, { hostname: 'SHOP-01' });
    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: hostTarget.id, reason: 'hostname' });

    // The hardware report brings the UUID.
    await getTestDb().update(deviceHardware).set({ systemUuid: UUID }).where(eq(deviceHardware.deviceId, source.id));
    expect(await detect(source.id, 'hardware_report')).toMatchObject({ written: true, kind: 'upgrade', targetDeviceId: hwTarget.id, reason: 'hardware' });
    expect(await flagOf(source.id)).toMatchObject({ target: hwTarget.id, reason: 'hardware' });

    // The UUID disappears again: the hostname match is still there but never downgrades the flag.
    await getTestDb().update(deviceHardware).set({ systemUuid: null }).where(eq(deviceHardware.deviceId, source.id));
    expect(await detect(source.id, 'hardware_report')).toEqual({ written: false, why: 'not_better' });
    expect(await flagOf(source.id)).toMatchObject({ target: hwTarget.id, reason: 'hardware' });
  });

  it('an identical report twice writes and notifies once', async () => {
    const tenant = await seedReattachTenant();
    await enableAlertRule(tenant.orgA.orgId);
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    expect(await detect(source.id, 'hardware_report')).toMatchObject({ written: true });
    const first = await flagOf(source.id);
    expect(await detect(source.id, 'hardware_report')).toEqual({ written: false, why: 'identical' });
    expect(await flagOf(source.id)).toEqual(first);
    expect(await suspectedEvents(tenant.orgA.orgId)).toHaveLength(1);
    expect(await alertsOn(target.id)).toHaveLength(1);
  });

  it('never looks outside the source\'s partner', async () => {
    const tenant = await seedReattachTenant();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreign = await oldTarget({ orgId: otherOrg.id, siteId: otherSite.id }, { systemUuid: UUID, serialNumber: 'SN-X', manufacturer: 'Dell' }, { hostname: 'SAME-NAME' });
    const source = await newSource(tenant.orgB, { systemUuid: UUID, serialNumber: 'SN-X', manufacturer: 'Dell' }, { hostname: 'SAME-NAME' });
    expect(await detect(source.id)).toEqual({ written: false, why: 'no_candidate' });
    expect((await flagOf(source.id)).target).toBeNull();
    expect(await suspectedEvents(otherOrg.id)).toHaveLength(0);
    expect((await flagOf(foreign.id)).target).toBeNull();
  });

  it('skips a target that is alive (seen after the source enrolled)', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    await getTestDb().update(devices).set({ lastSeenAt: new Date(Date.now() + 1000) }).where(eq(devices.id, target.id));
    expect(await detect(source.id)).toEqual({ written: false, why: 'no_candidate' });
  });

  it('skips a target alive by its watchdog only', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    await getTestDb().update(devices).set({ watchdogLastSeen: new Date(Date.now() + 1000) }).where(eq(devices.id, target.id));
    expect(await detect(source.id)).toEqual({ written: false, why: 'no_candidate' });
  });

  it('skips ephemeral, parked, retired-source and same-link-group targets', async () => {
    const tenant = await seedReattachTenant();
    await oldTarget(tenant.orgA, { systemUuid: UUID }, { isEphemeral: true });
    await oldTarget(tenant.pool, { systemUuid: UUID }, { parked: true });
    const retired = await oldTarget(tenant.orgA, { systemUuid: UUID });
    await getTestDb().insert(deviceReattachments).values({
      partnerId: tenant.partnerId,
      intentId: randomUUID(),
      sourceDeviceId: retired.id,
      sourceAgentId: retired.agentId,
      sourceOrgId: tenant.orgA.orgId,
      sourceParked: false,
      targetDeviceId: randomUUID(),
      targetOrgId: tenant.orgA.orgId,
      targetSiteId: tenant.orgA.siteId,
      targetPreviousAgentId: 'old',
      stagedAgentId: 'new',
      targetPreviousIncarnation: 1,
      targetNewIncarnation: 2,
      actorUserId: tenant.admin.id,
      evidenceLevel: 'hint',
      confirmationTokenHash: randomUUID().replace(/-/g, '').repeat(2),
    });
    const sibling = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgA, { systemUuid: UUID });
    const [group] = await getTestDb().execute(sql`
      INSERT INTO device_link_groups (org_id, kind) VALUES (${tenant.orgA.orgId}::uuid, 'multiboot') RETURNING id`) as unknown as Array<{ id: string }>;
    await getTestDb().update(devices).set({ linkGroupId: group!.id, linkGroupRole: null }).where(eq(devices.id, sibling.id));
    await getTestDb().update(devices).set({ linkGroupId: group!.id, linkGroupRole: null }).where(eq(devices.id, source.id));

    expect(await detect(source.id)).toEqual({ written: false, why: 'no_candidate' });
    expect((await flagOf(source.id)).target).toBeNull();
  });

  it('flags a decommissioned target (decommissioned before the source enrolled)', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID }, { status: 'decommissioned' });
    await getTestDb().execute(sql`UPDATE devices SET decommissioned_at = now() - interval '1 day' WHERE id = ${target.id}::uuid`);
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: target.id, reason: 'hardware' });
  });

  it('flags a parked source; the event, alert and audit carry no source identity', async () => {
    const tenant = await seedReattachTenant();
    await enableAlertRule(tenant.orgA.orgId);
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID }, { hostname: 'TARGET-HOST' });
    const source = await newSource(tenant.pool, { systemUuid: UUID }, { parked: true, hostname: 'PARKED-SECRET' });

    expect(await detect(source.id)).toMatchObject({ written: true, targetDeviceId: target.id, reason: 'hardware' });
    expect(await flagOf(source.id)).toMatchObject({ target: target.id, reason: 'hardware' });

    const [event] = await suspectedEvents(tenant.orgA.orgId);
    expect(event!.payload).toMatchObject({ targetDeviceId: target.id, sourceParked: true });
    expect(event!.payload).not.toHaveProperty('sourceDeviceId');
    expect(event!.payload).not.toHaveProperty('sourceHostname');
    expect(await suspectedEvents(tenant.pool.orgId)).toHaveLength(0);

    const [alert] = await alertsOn(target.id);
    expect(alert!.message).toContain(PARKED_SOURCE_LABEL);
    for (const text of [JSON.stringify(alert), JSON.stringify(event)]) {
      expect(text).not.toContain(source.id);
      expect(text).not.toContain('PARKED-SECRET');
    }
    const audits = await waitFor(() => suspectedAudits(target.id), (rows) => rows.length > 0);
    expect(audits.map((a) => a.orgId)).toEqual([tenant.orgA.orgId]);
    expect(JSON.stringify(audits)).not.toContain('PARKED-SECRET');
  });

  it('names a same-org source in the event and the alert', async () => {
    const tenant = await seedReattachTenant();
    await enableAlertRule(tenant.orgA.orgId);
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgA, { systemUuid: UUID }, { hostname: 'NEW-INSTALL' });
    await detect(source.id);
    const [event] = await suspectedEvents(tenant.orgA.orgId);
    expect(event!.payload).toMatchObject({ sourceDeviceId: source.id, sourceHostname: 'NEW-INSTALL', sourceParked: false });
    const [alert] = await alertsOn(target.id);
    expect(alert!.message).toContain('NEW-INSTALL');
  });

  it('raises no alert without a rule (opt-in), but still flags, publishes and audits', async () => {
    const tenant = await seedReattachTenant();
    await replayMigration('2027-01-19-110300-device-reinstall-suspected-alert-template.sql');
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, { systemUuid: UUID });
    expect(await detect(source.id)).toMatchObject({ written: true });
    expect(await alertsOn(target.id)).toHaveLength(0);
    expect(await suspectedEvents(tenant.orgA.orgId)).toHaveLength(1);
  });
});

/** The constraint a failed write violated (Drizzle wraps the driver error in `cause`). */
async function violatedConstraint(write: PromiseLike<unknown>): Promise<string | null> {
  try {
    await write;
    return null;
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? (err as { constraint_name?: string }).constraint_name ?? String(err);
  }
}

describe('reinstall candidates — clears and the CHECK', () => {
  async function flaggedPair(tenant: ReattachTenant) {
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgA, { systemUuid: UUID });
    await detect(source.id);
    expect(await flagOf(source.id)).toMatchObject({ target: target.id, reason: 'hardware' });
    return { target, source };
  }

  it('the uninstall-intent reaper clears all three columns', async () => {
    const tenant = await seedReattachTenant();
    const { target, source } = await flaggedPair(tenant);
    await getTestDb().execute(sql`
      UPDATE devices SET uninstall_intent_at = now() - interval '2 days', last_seen_at = now() - interval '3 days'
       WHERE id = ${target.id}::uuid`);
    const previous = process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS;
    process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = '0';
    try {
      await withSystemDbAccessContext(() => processReapUninstallIntent());
    } finally {
      if (previous === undefined) delete process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS;
      else process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = previous;
    }
    expect((await readDevice(target.id))?.status).toBe('decommissioned');
    expect(await flagOf(source.id)).toEqual({ target: null, reason: null, detectedAt: null });
    // Retired after the source enrolled: the answer sticks, the next report does not re-flag.
    expect(await detect(source.id, 'hardware_report')).toEqual({ written: false, why: 'no_candidate' });
  });

  it('deleting the target clears the reason with the link (ON DELETE SET NULL + clear trigger)', async () => {
    const tenant = await seedReattachTenant();
    const { target, source } = await flaggedPair(tenant);
    await getTestDb().delete(deviceHardware).where(eq(deviceHardware.deviceId, target.id));
    await getTestDb().delete(devices).where(eq(devices.id, target.id));
    expect(await flagOf(source.id)).toEqual({ target: null, reason: null, detectedAt: null });
  });

  it('a link written without a reason (an API from before this wave, mid rolling deploy) defaults to hostname', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, {});
    // INSERT path: the #2764 fresh row as a pre-2-1 binary writes it.
    const inserted = await seedAgentDevice(tenant.orgA, { status: 'pending', possibleReplacementOfDeviceId: target.id });
    const insertedFlag = await flagOf(inserted.id);
    expect(insertedFlag).toMatchObject({ target: target.id, reason: 'hostname' });
    expect(insertedFlag.detectedAt).not.toBeNull();
    // UPDATE path: only the link in the SET list.
    const updated = await newSource(tenant.orgA, {});
    await getTestDb().update(devices).set({ possibleReplacementOfDeviceId: target.id }).where(eq(devices.id, updated.id));
    const updatedFlag = await flagOf(updated.id);
    expect(updatedFlag).toMatchObject({ target: target.id, reason: 'hostname' });
    expect(updatedFlag.detectedAt).not.toBeNull();
    // A writer that names a reason keeps it.
    const hinted = await newSource(tenant.orgA, {});
    await getTestDb().update(devices)
      .set({ possibleReplacementOfDeviceId: target.id, possibleReplacementReason: 'hardware', possibleReplacementDetectedAt: new Date() })
      .where(eq(devices.id, hinted.id));
    expect(await flagOf(hinted.id)).toMatchObject({ target: target.id, reason: 'hardware' });
  });

  it('the migration backfills a pre-existing #2764 link to hostname at created_at, then the CHECK holds', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, {});
    const source = await newSource(tenant.orgA, {});
    // The state before 2027-01-19-110000: a link with no reason, and neither
    // the CHECK nor the sync trigger (the replay below re-creates the trigger).
    await getTestDb().execute(sql`ALTER TABLE devices DROP CONSTRAINT devices_possible_replacement_reason_chk`);
    await getTestDb().execute(sql`DROP TRIGGER devices_possible_replacement_reason_sync ON devices`);
    try {
      await getTestDb().execute(sql`
        UPDATE devices SET possible_replacement_of_device_id = ${target.id}::uuid WHERE id = ${source.id}::uuid`);
      expect(await flagOf(source.id)).toEqual({ target: target.id, reason: null, detectedAt: null });
      // Bare replay: the file redefines no function a later file redefines; its
      // only follower (2027-01-19-110200, VALIDATE) is @no-transaction, so the
      // VALIDATE is run by hand below.
      const file = await readFile(new URL('../../../migrations/2027-01-19-110000-device-possible-replacement-reason.sql', import.meta.url), 'utf8');
      await getTestDb().transaction(async (tx) => { await tx.execute(sql.raw(file)); });
    } finally {
      await getTestDb().execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'devices_possible_replacement_reason_sync') THEN
            CREATE TRIGGER devices_possible_replacement_reason_sync
              BEFORE INSERT OR UPDATE OF possible_replacement_of_device_id ON devices
              FOR EACH ROW EXECUTE FUNCTION breeze_devices_possible_replacement_reason_sync();
          END IF;
        END $$`);
      await getTestDb().execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_possible_replacement_reason_chk') THEN
            ALTER TABLE devices ADD CONSTRAINT devices_possible_replacement_reason_chk CHECK (
              (possible_replacement_of_device_id IS NULL) = (possible_replacement_reason IS NULL)
              AND (possible_replacement_of_device_id IS NULL) = (possible_replacement_detected_at IS NULL)) NOT VALID;
          END IF;
        END $$`);
      await getTestDb().execute(sql`ALTER TABLE devices VALIDATE CONSTRAINT devices_possible_replacement_reason_chk`);
    }
    const row = await readDevice(source.id);
    expect(row?.possibleReplacementReason).toBe('hostname');
    expect(row?.possibleReplacementDetectedAt?.getTime()).toBe(row?.createdAt.getTime());
  });

  it('the CHECK refuses a reason without a link and a reason outside the vocabulary', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, {});
    const source = await newSource(tenant.orgA, {});
    // A link without a reason is defaulted by the sync trigger (see the
    // rolling-deploy test above). A reason written without the link is not
    // in the trigger's column list, so the pairing CHECK is what refuses it.
    expect(await violatedConstraint(getTestDb().update(devices)
      .set({ possibleReplacementReason: 'hostname', possibleReplacementDetectedAt: new Date() })
      .where(eq(devices.id, source.id))))
      .toBe('devices_possible_replacement_reason_chk');
    expect(await violatedConstraint(getTestDb().execute(sql`
      UPDATE devices SET possible_replacement_of_device_id = ${target.id}::uuid,
             possible_replacement_reason = 'guess', possible_replacement_detected_at = now()
       WHERE id = ${source.id}::uuid`))).toBe('devices_possible_replacement_reason_values_chk');
  });
});

// ─── Wiring: enrollment and the hardware report ────────────────────────────

function agentRequestContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: null };
}

async function makeEnrollmentKey(place: Place, rawKey: string) {
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: place.orgId,
      siteId: place.siteId,
      name: 'Reinstall hints key',
      key: hashEnrollmentKey(rawKey),
      keySecretHash: null,
      usageCount: 0,
      maxUsage: null,
      expiresAt: null,
    });
  });
}

async function enroll(rawKey: string, hostname: string, hardwareInfo: Record<string, unknown>) {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  const res = await app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enrollmentKey: rawKey, hostname, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '1.0.0-test', hardwareInfo,
    }),
  });
  return { status: res.status, body: await res.json() as { deviceId: string; agentId: string } };
}

describe('reinstall candidates — wiring', () => {
  it('enrollment stores the normalized UUID and flags the new device after commit', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const rawKey = `hints-key-${randomUUID()}`;
    await makeEnrollmentKey(tenant.orgB, rawKey);

    const res = await enroll(rawKey, `hints-${randomUUID().slice(0, 8)}`, { serialNumber: 'X1', systemUuid: UUID.toUpperCase() });
    expect(res.status).toBe(201);
    const [hw] = await getTestDb().select().from(deviceHardware).where(eq(deviceHardware.deviceId, res.body.deviceId));
    expect(hw!.systemUuid).toBe(UUID);
    const flag = await waitFor(() => flagOf(res.body.deviceId), (f) => f.target !== null);
    expect(flag).toMatchObject({ target: target.id, reason: 'hardware' });
  });

  it('a malformed UUID never fails enrollment and is stored as NULL', async () => {
    const tenant = await seedReattachTenant();
    const rawKey = `hints-key-${randomUUID()}`;
    await makeEnrollmentKey(tenant.orgB, rawKey);
    const res = await enroll(rawKey, `hints-${randomUUID().slice(0, 8)}`, { serialNumber: 'X1', systemUuid: '03000200-0400-0500-0006-000700080009' });
    expect(res.status).toBe(201);
    const [hw] = await getTestDb().select().from(deviceHardware).where(eq(deviceHardware.deviceId, res.body.deviceId));
    expect(hw!.systemUuid).toBeNull();
    expect(hw!.serialNumber).toBe('X1');
  });

  it('the #2764 collision path records hostname and still raises its own alert path', async () => {
    const tenant = await seedReattachTenant();
    const rawKey = `hints-key-${randomUUID()}`;
    await makeEnrollmentKey(tenant.orgA, rawKey);
    const hostname = `collide-${randomUUID().slice(0, 8)}`;
    const first = await enroll(rawKey, hostname, {});
    const second = await enroll(rawKey, hostname, {});
    expect(second.status).toBe(201);
    const flag = await flagOf(second.body.deviceId);
    expect(flag).toMatchObject({ target: first.body.deviceId, reason: 'hostname' });
    expect(flag.detectedAt).toBeInstanceOf(Date);
  });

  it('a hardware report (as breeze_app, org-scoped) stores the UUID, keeps it when omitted, and flags after commit', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldTarget(tenant.orgA, { systemUuid: UUID });
    const source = await newSource(tenant.orgB, {});

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: source.id, agentId: source.agentId, orgId: tenant.orgB.orgId, siteId: tenant.orgB.siteId, role: 'agent' } as never);
      await next();
    });
    app.route('/agents', inventoryRoutes);
    const put = (body: unknown) => withDbAccessContext(agentRequestContext(tenant.orgB.orgId), async () =>
      app.request(`/agents/${source.agentId}/hardware`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));

    expect((await put({ cpuModel: 'x', systemUuid: `{${UUID_SWAPPED.toUpperCase()}}` })).status).toBe(200);
    const flag = await waitFor(() => flagOf(source.id), (f) => f.target !== null);
    expect(flag).toMatchObject({ target: target.id, reason: 'hardware' });
    const readUuid = async () => (await getTestDb().select().from(deviceHardware).where(eq(deviceHardware.deviceId, source.id)))[0]!.systemUuid;
    expect(await readUuid()).toBe(UUID_SWAPPED);

    // An omitted key keeps the stored value; a rejected one stores NULL.
    expect((await put({ cpuModel: 'y' })).status).toBe(200);
    expect(await readUuid()).toBe(UUID_SWAPPED);
    expect((await put({ cpuModel: 'y', systemUuid: 'garbage' })).status).toBe(200);
    expect(await readUuid()).toBeNull();
  });
});
