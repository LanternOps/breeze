/**
 * #8318 wave 1b-1 — the two review notes on #9385, against real PostgreSQL:
 *
 *  (a) breeze_device_command_incarnation_is_current(command_id) evaluates the
 *      CALLER's org access to the command's device org before it answers
 *      (migration 2027-01-05-090000): an org/partner context without access
 *      gets false for a current command; system and contextless callers keep
 *      their answer (the documented rule for the result paths' bare-pool reads).
 *
 *  (b) snapshotPredatesDeviceIncarnationSql fails CLOSED under RLS: a caller
 *      that cannot see the device row reads "predates" (true), never the
 *      "snapshot is current" free pass.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { snapshotPredatesDeviceIncarnationSql } from '../../services/backupRestoreIntegrity';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, partnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId };
}

async function makeDevice() {
  const env = await setupTestEnvironment();
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id, siteId: env.site.id, agentId: `access-${randomUUID()}`,
      hostname: `access-${randomUUID()}`, osType: 'windows', osVersion: '11', architecture: 'x86_64',
      agentVersion: '0.0.0-test', status: 'online',
    })
    .returning({ id: devices.id });
  return { env, deviceId: device!.id, orgId: env.organization.id, partnerId: env.partner.id };
}

async function advance(deviceId: string): Promise<void> {
  await getTestDb().execute(sql`
    UPDATE devices SET install_incarnation = install_incarnation + 1, incarnation_started_at = now()
     WHERE id = ${deviceId}::uuid`);
}

describe('breeze_device_command_incarnation_is_current — caller org access (#8318 §6.4, review note a)', () => {
  async function isCurrent(commandId: string): Promise<boolean | null> {
    const rows = (await db.execute(
      sql`SELECT public.breeze_device_command_incarnation_is_current(${commandId}::uuid) AS v`,
    )) as unknown as Array<{ v: boolean | null }>;
    return rows[0]?.v ?? null;
  }

  runDb('an org context without access to the device\'s org gets false for a current command; one with access gets true', async () => {
    const fx = await makeDevice();
    const [cmd] = await getTestDb().insert(deviceCommands)
      .values({ deviceId: fx.deviceId, type: 'refresh_inventory' }).returning({ id: deviceCommands.id });
    const other = await setupTestEnvironment();

    expect(await withDbAccessContext(orgContext(other.organization.id, other.partner.id), () => isCurrent(cmd!.id))).toBe(false);
    expect(await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () => isCurrent(cmd!.id))).toBe(true);
    // A partner context whose accessible orgs include the device's org.
    expect(await withDbAccessContext(partnerContext(fx.partnerId, [fx.orgId]), () => isCurrent(cmd!.id))).toBe(true);
    // ...and one of another partner that does not.
    const otherPartner = await createPartner();
    const otherPartnerOrg = await createOrganization({ partnerId: otherPartner.id });
    expect(await withDbAccessContext(partnerContext(otherPartner.id, [otherPartnerOrg.id]), () => isCurrent(cmd!.id))).toBe(false);
  });

  runDb('system scope and a contextless (bare breeze_app) caller keep their answer, as documented', async () => {
    const fx = await makeDevice();
    const [cmd] = await getTestDb().insert(deviceCommands)
      .values({ deviceId: fx.deviceId, type: 'refresh_inventory' }).returning({ id: deviceCommands.id });

    expect(await withSystemDbAccessContext(() => isCurrent(cmd!.id))).toBe(true);
    const contextless = (await getAppDb().execute(
      sql`SELECT public.breeze_device_command_incarnation_is_current(${cmd!.id}::uuid) AS v`,
    )) as unknown as Array<{ v: boolean }>;
    expect(contextless[0]?.v).toBe(true);
    const scope = (await getAppDb().execute(sql`SELECT public.breeze_current_scope() AS s`)) as unknown as Array<{ s: string }>;
    expect(scope[0]?.s).toBe('none');

    // The incarnation half still rules every scope.
    await advance(fx.deviceId);
    expect(await withSystemDbAccessContext(() => isCurrent(cmd!.id))).toBe(false);
    expect(await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () => isCurrent(cmd!.id))).toBe(false);
  });

  runDb('restores the caller\'s scope and answers false for an unknown command', async () => {
    const fx = await makeDevice();
    await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), async () => {
      expect(await isCurrent(randomUUID())).toBe(false);
      const scope = (await db.execute(sql`SELECT public.breeze_current_scope() AS s`)) as unknown as Array<{ s: string }>;
      expect(scope[0]?.s).toBe('organization');
    });
  });

  runDb('pins the resolver shape: SECURITY DEFINER, fixed search_path, EXECUTE only for breeze_app', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT p.prosecdef AS secdef, p.proconfig AS config,
             has_function_privilege('breeze_app', p.oid, 'EXECUTE') AS app_can_execute,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'breeze_device_command_incarnation_is_current'`)) as unknown as Array<{
      secdef: boolean; config: string[] | null; app_can_execute: boolean; public_can_execute: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ secdef: true, app_can_execute: true, public_can_execute: false });
    expect(rows[0]!.config).toEqual(['search_path=pg_catalog, public']);
  });
});

describe('snapshotPredatesDeviceIncarnationSql fails closed under RLS (#8318 §5.4, review note b)', () => {
  async function predates(deviceId: string, at: Date): Promise<boolean> {
    const rows = (await db.execute(sql`SELECT ${snapshotPredatesDeviceIncarnationSql(
      sql`${deviceId}::uuid`,
      sql`${at.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`,
    )} AS v`)) as unknown as Array<{ v: boolean }>;
    return rows[0]!.v;
  }

  runDb('a caller that cannot see the device reads "predates"; a caller that can reads the real answer', async () => {
    const fx = await makeDevice();
    const other = await setupTestEnvironment();
    const now = new Date();

    // Never reattached: visible callers read false (today's behaviour)...
    expect(await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () => predates(fx.deviceId, now))).toBe(false);
    expect(await withSystemDbAccessContext(() => predates(fx.deviceId, now))).toBe(false);
    // ...an invisible device reads true, the fail-closed answer.
    expect(await withDbAccessContext(orgContext(other.organization.id, other.partner.id), () => predates(fx.deviceId, now))).toBe(true);
    // A device that does not exist at all reads true too.
    expect(await withSystemDbAccessContext(() => predates(randomUUID(), now))).toBe(true);

    // Reattached: a snapshot before the boundary predates, one after does not — for a visible caller.
    await advance(fx.deviceId);
    const [row] = await getTestDb().select({ started: devices.incarnationStartedAt }).from(devices)
      .where(sql`${devices.id} = ${fx.deviceId}::uuid`);
    const hourBefore = new Date(row!.started!.getTime() - 3_600_000);
    const hourAfter = new Date(row!.started!.getTime() + 3_600_000);
    expect(await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () => predates(fx.deviceId, hourBefore))).toBe(true);
    expect(await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () => predates(fx.deviceId, hourAfter))).toBe(false);
    // The invisible caller still reads true for both.
    expect(await withDbAccessContext(orgContext(other.organization.id, other.partner.id), () => predates(fx.deviceId, hourAfter))).toBe(true);
  });
});
