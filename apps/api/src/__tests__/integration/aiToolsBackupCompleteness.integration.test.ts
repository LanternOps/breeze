/**
 * Integration test — W17 (#6788) backup verification, recovery and C2C config tools
 * honour the org and site axes against real Postgres as the unprivileged
 * `breeze_app` role.
 *
 * The verification services open a system context, and that only narrows to the caller
 * because a nested context keeps the ambient one. So a wrong org is stopped twice under a
 * tool call: by the tool's own predicate, and by RLS on the ambient context. The controls
 * below show each layer on its own. The site and exact-device axes have no RLS at all.
 *
 * Fixture: partner P with org O1 (sites S1, S2; a device in each, each with a backup
 * verification and a bare-metal recovery) and org O2 (one device, one verification).
 * Callers:
 *   restricted  org token for O1, allowed site S1 only
 *   orgAll      org token for O1, no site restriction
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { bareMetalRecoveries, c2cBackupConfigs, c2cBackupJobs, c2cConnections, devices } from '../../db/schema';
import { listBackupVerifications } from '../../routes/backup/verificationService';
import { registerBackupRecoveryReadTools } from '../../services/aiToolsBackupRecoveryReads';
import { registerBackupVerificationTools } from '../../services/aiToolsBackupVerification';
import { registerC2CConfigTools } from '../../services/aiToolsC2CConfigs';
import { C2C_CONFIG_HISTORY_FKS } from '../../services/c2cConfigService';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const tools = new Map<string, AiTool>();
registerBackupVerificationTools(tools);
registerBackupRecoveryReadTools(tools);
registerC2CConfigTools(tools);

const SENTINEL = 'SENTINEL-do-not-reach-the-model';

type Who = 'restricted' | 'orgAll' | 'deviceBound';

interface Fixture {
  partnerId: string; o1: string; o2: string; userId: string; s1: string;
  dIn: string; dOut: string; dO2: string; dSibling: string;
  recoveryIn: string; recoveryOut: string; recoverySibling: string;
  auth: Record<Who, AuthContext>;
}

function orgAuth(userId: string, partnerId: string, orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId, orgId, scope: 'organization', accessibleOrgIds: [orgId],
    orgCondition: (col: PgColumn) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'backup-completeness' },
  } as unknown as AuthContext;
}

const db = () => getTestDb();

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await db().insert(devices).values({
    orgId, siteId, agentId: `w17-${randomUUID()}`, hostname: `w17-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedVerification(orgId: string, deviceId: string): Promise<void> {
  const configId = randomUUID();
  const jobId = randomUUID();
  await db().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
      VALUES (${configId}, ${orgId}, 'W17', 'file', 'local', '{}'::jsonb)
  `);
  await db().execute(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type)
      VALUES (${jobId}, ${orgId}, ${configId}, ${deviceId}, 'completed', 'manual')
  `);
  await db().execute(sql`
    INSERT INTO backup_verifications (org_id, device_id, backup_job_id, verification_type, status, started_at, completed_at, details)
      VALUES (${orgId}, ${deviceId}, ${jobId}, 'integrity', 'failed', now(), now(),
        ${JSON.stringify({ reason: 'checksum mismatch', restorePath: SENTINEL })}::jsonb)
  `);
}

async function seedRecovery(orgId: string, deviceId: string): Promise<string> {
  const [row] = await db().insert(bareMetalRecoveries).values({
    orgId, deviceId, identity: 'original', status: 'failed',
    codeHash: randomUUID().replaceAll('-', ''), nonceHash: randomUUID().replaceAll('-', ''),
    codeExpiresAt: new Date(Date.now() + 3_600_000),
    target: { secret: SENTINEL }, plan: { secret: SENTINEL }, result: { secret: SENTINEL },
    failureReason: 'disk not found', warnings: ['low space'],
  }).returning({ id: bareMetalRecoveries.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const p = await createPartner();
  const o1 = await createOrganization({ partnerId: p.id });
  const o2 = await createOrganization({ partnerId: p.id });
  const s1 = await createSite({ orgId: o1.id, name: 'W17 S1' });
  const s2 = await createSite({ orgId: o1.id, name: 'W17 S2' });
  const s3 = await createSite({ orgId: o2.id, name: 'W17 S3' });
  const user = await createUser({ partnerId: p.id, orgId: o1.id, email: `w17-${randomUUID()}@example.com` });
  const dIn = await seedDevice(o1.id, s1.id);
  const dSibling = await seedDevice(o1.id, s1.id);
  const dOut = await seedDevice(o1.id, s2.id);
  const dO2 = await seedDevice(o2.id, s3.id);
  for (const [org, d] of [[o1.id, dIn], [o1.id, dSibling], [o1.id, dOut], [o2.id, dO2]] as const) await seedVerification(org, d);
  await db().execute(sql`
    INSERT INTO recovery_readiness (org_id, device_id, readiness_score, risk_factors, calculated_at) VALUES
      (${o1.id}, ${dIn}, 90, '[]'::jsonb, now()),
      (${o1.id}, ${dSibling}, 50, '[]'::jsonb, now()),
      (${o1.id}, ${dOut}, 10, '[]'::jsonb, now())
  `);
  // A device-bound run (agentAuthContext): pinned to one device and its site.
  const deviceBound = { ...orgAuth(user.id, p.id, o1.id, [s1.id]), allowedDeviceIds: [dIn] } as unknown as AuthContext;
  return {
    partnerId: p.id, o1: o1.id, o2: o2.id, userId: user.id, s1: s1.id, dIn, dOut, dO2, dSibling,
    recoveryIn: await seedRecovery(o1.id, dIn),
    recoveryOut: await seedRecovery(o1.id, dOut),
    recoverySibling: await seedRecovery(o1.id, dSibling),
    auth: { restricted: orgAuth(user.id, p.id, o1.id, [s1.id]), orgAll: orgAuth(user.id, p.id, o1.id), deviceBound },
  };
}

const ctxFor = (f: Fixture): DbAccessContext => ({
  scope: 'organization', orgId: f.o1, accessibleOrgIds: [f.o1], accessiblePartnerIds: [], userId: f.userId, currentPartnerId: f.partnerId,
});

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const handler = tools.get(tool)!.handler;
  const raw = await withDbAccessContext(ctxFor(f), () => handler(input, f.auth[who]));
  return { raw, out: JSON.parse(raw) as Record<string, any> };
}

describe('manage_backup_verification — org and site axes', () => {
  let f: Fixture;
  beforeEach(async () => { f = await seedFixture(); });

  runDb('org A never reads org B rows, with a control for each layer that stops it', async () => {
    const { out } = await run(f, 'orgAll', 'manage_backup_verification', { action: 'list' });
    const seen = out.verifications.map((v: { deviceId: string }) => v.deviceId);
    expect(seen.sort()).toEqual([f.dIn, f.dSibling, f.dOut].sort());

    const named = await run(f, 'orgAll', 'manage_backup_verification', { action: 'list', orgId: f.o2 });
    expect(named.out).toMatchObject({ code: 'ACCESS_DENIED' });
    const viaDevice = await run(f, 'orgAll', 'manage_backup_verification', { action: 'list', deviceId: f.dO2 });
    expect(viaDevice.out).toMatchObject({ code: 'NOT_FOUND' });

    // Control 1: the service takes any org it is handed, so with no ambient context it DOES return org B's row.
    // If this stopped being true, the refusals above would pass for the wrong reason.
    const unscoped = await listBackupVerifications(f.o2, {});
    expect(unscoped.map((row) => row.deviceId)).toEqual([f.dO2]);
    // Control 2: with the tool's predicate lifted but the caller's context in place, RLS still returns nothing.
    expect(await withDbAccessContext(ctxFor(f), () => listBackupVerifications(f.o2, {}))).toEqual([]);
  });

  runDb('a site-restricted caller sees only allowed-site rows, and the device name resolves', async () => {
    const { out, raw } = await run(f, 'restricted', 'manage_backup_verification', { action: 'list', deviceId: f.dIn });
    expect(out.verifications.map((v: { deviceId: string }) => v.deviceId)).toEqual([f.dIn]);
    expect(out.verifications[0]).toMatchObject({ status: 'failed', reason: 'checksum mismatch' });
    const all = await run(f, 'restricted', 'manage_backup_verification', { action: 'list' });
    expect(all.out.verifications.map((v: { deviceId: string }) => v.deviceId).sort()).toEqual([f.dIn, f.dSibling].sort());
    expect(out.verifications[0].deviceName).toMatch(/^w17-/);
    expect(raw).not.toContain(SENTINEL);

    const hidden = await run(f, 'restricted', 'manage_backup_verification', { action: 'list', deviceId: f.dOut });
    expect(hidden.out).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('exact-device axis: a same-site sibling is invisible to a device-bound run', () => {
  let f: Fixture;
  beforeEach(async () => { f = await seedFixture(); });

  runDb('verification: list needs its own device, and a same-site sibling is not found', async () => {
    expect((await run(f, 'deviceBound', 'manage_backup_verification', { action: 'list' })).out).toMatchObject({ code: 'ACCESS_DENIED' });
    const own = await run(f, 'deviceBound', 'manage_backup_verification', { action: 'list', deviceId: f.dIn });
    expect(own.out.verifications.map((v: { deviceId: string }) => v.deviceId)).toEqual([f.dIn]);
    const sibling = await run(f, 'deviceBound', 'manage_backup_verification', { action: 'list', deviceId: f.dSibling });
    expect(sibling.out).toMatchObject({ code: 'NOT_FOUND' });
    const readiness = await run(f, 'deviceBound', 'manage_backup_verification', { action: 'readiness', deviceId: f.dIn });
    expect(readiness.out.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([f.dIn]);
    expect((await run(f, 'deviceBound', 'manage_backup_verification', { action: 'health' })).out).toMatchObject({ code: 'ACCESS_DENIED' });
  });

  runDb('recoveries: the list holds only its device; get on the same-site sibling is not found', async () => {
    const list = await run(f, 'deviceBound', 'list_bmr_recoveries', { action: 'list' });
    expect(list.out.recoveries.map((r: { id: string }) => r.id)).toEqual([f.recoveryIn]);
    const sibling = await run(f, 'deviceBound', 'list_bmr_recoveries', { action: 'get', recoveryId: f.recoverySibling });
    expect(sibling.out).toMatchObject({ code: 'NOT_FOUND' });
  });

  runDb('backup health: refused whole', async () => {
    expect((await run(f, 'deviceBound', 'get_backup_health', {})).out).toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

describe('site axis on the readiness and backup-health reads', () => {
  let f: Fixture;
  beforeEach(async () => { f = await seedFixture(); });

  runDb('readiness: a restricted caller is summarized over its own site only', async () => {
    const { out } = await run(f, 'restricted', 'manage_backup_verification', { action: 'readiness' });
    expect(out.devices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual([f.dIn, f.dSibling].sort());
    expect(out.summary.devices).toBe(2);
    const everyone = await run(f, 'orgAll', 'manage_backup_verification', { action: 'readiness' });
    expect(everyone.out.devices.map((d: { deviceId: string }) => d.deviceId)).toContain(f.dOut);
  });

  runDb('backup health: a restricted caller sees only its site, and the summary agrees', async () => {
    const restricted = await run(f, 'restricted', 'get_backup_health', { withBackup: false, limit: 100 });
    const ids = restricted.out.rows.map((r: { deviceId: string }) => r.deviceId);
    expect(ids.sort()).toEqual([f.dIn, f.dSibling].sort());
    expect(restricted.out.summary.endpoints.total).toBe(2);

    const everyone = await run(f, 'orgAll', 'get_backup_health', { withBackup: false, limit: 100 });
    const all = everyone.out.rows.map((r: { deviceId: string }) => r.deviceId);
    expect(all).toContain(f.dOut);
    expect(all).not.toContain(f.dO2);
  });
});

describe('list_bmr_recoveries — projection and site axis', () => {
  let f: Fixture;
  beforeEach(async () => { f = await seedFixture(); });

  runDb('serialized output carries no sentinel from target, plan or result, and says they exist', async () => {
    const list = await run(f, 'orgAll', 'list_bmr_recoveries', { action: 'list' });
    expect(list.out.count).toBe(3);
    expect(list.raw).not.toContain(SENTINEL);
    expect(list.out.recoveries[0]).toMatchObject({ hasTarget: true, hasPlan: true, hasResult: true, failureReason: 'disk not found', warnings: ['low space'] });

    const get = await run(f, 'orgAll', 'list_bmr_recoveries', { action: 'get', recoveryId: f.recoveryIn });
    expect(get.raw).not.toContain(SENTINEL);
    expect(get.out.recovery).toMatchObject({ id: f.recoveryIn, deviceId: f.dIn, hasResult: true });
  });

  runDb('a hidden-site recovery is the same not-found as a missing one', async () => {
    const list = await run(f, 'restricted', 'list_bmr_recoveries', { action: 'list' });
    expect(list.out.recoveries.map((r: { id: string }) => r.id).sort()).toEqual([f.recoveryIn, f.recoverySibling].sort());

    const hidden = await run(f, 'restricted', 'list_bmr_recoveries', { action: 'get', recoveryId: f.recoveryOut });
    const missing = await run(f, 'restricted', 'list_bmr_recoveries', { action: 'get', recoveryId: randomUUID() });
    expect(hidden.out).toMatchObject({ code: 'NOT_FOUND' });
    expect(hidden.out).toEqual(missing.out);

    const visible = await run(f, 'restricted', 'list_bmr_recoveries', { action: 'get', recoveryId: f.recoveryIn });
    expect(visible.out.recovery.id).toBe(f.recoveryIn);
  });
});

describe('manage_c2c_configs — delete against the real foreign keys', () => {
  let f: Fixture;
  beforeEach(async () => { f = await seedFixture(); });

  async function seedConfig(): Promise<string> {
    const [connection] = await db().insert(c2cConnections).values({
      orgId: f.o1, provider: 'microsoft_365', displayName: 'W17',
    }).returning({ id: c2cConnections.id });
    const [config] = await db().insert(c2cBackupConfigs).values({
      orgId: f.o1, connectionId: connection!.id, name: 'W17 config', backupScope: 'mail',
    }).returning({ id: c2cBackupConfigs.id });
    return config!.id;
  }
  const configExists = async (id: string) => (await db().select().from(c2cBackupConfigs).where(eq(c2cBackupConfigs.id, id))).length === 1;

  runDb('with a job row: CONFIG_HAS_HISTORY, and the config and its history survive', async () => {
    const configId = await seedConfig();
    const [job] = await db().insert(c2cBackupJobs).values({ orgId: f.o1, configId }).returning({ id: c2cBackupJobs.id });

    const { out } = await run(f, 'orgAll', 'manage_c2c_configs', { action: 'delete', configId });
    expect(out).toMatchObject({ code: 'CONFIG_HAS_HISTORY' });
    expect(await configExists(configId)).toBe(true);
    expect(await db().select().from(c2cBackupJobs).where(eq(c2cBackupJobs.id, job!.id))).toHaveLength(1);
  });

  runDb('with no history: deleted, and a site-restricted caller cannot', async () => {
    const configId = await seedConfig();
    const denied = await run(f, 'restricted', 'manage_c2c_configs', { action: 'delete', configId });
    expect(denied.out).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await configExists(configId)).toBe(true);

    const { out } = await run(f, 'orgAll', 'manage_c2c_configs', { action: 'delete', configId });
    expect(out).toEqual({ deleted: true, configId });
    expect(await configExists(configId)).toBe(false);
  });

  runDb('with item history only: CONFIG_HAS_HISTORY, and the config survives', async () => {
    const configId = await seedConfig();
    await db().execute(sql`
      INSERT INTO c2c_backup_items (org_id, config_id, item_type, external_id, user_email)
        VALUES (${f.o1}, ${configId}, 'email', ${randomUUID()}, 'person@example.test')
    `);
    const { out } = await run(f, 'orgAll', 'manage_c2c_configs', { action: 'delete', configId });
    expect(out).toMatchObject({ code: 'CONFIG_HAS_HISTORY' });
    expect(await configExists(configId)).toBe(true);
  });

  runDb('the foreign keys the service names are the ones the schema has', async () => {
    const rows = await db().execute(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'c2c_backup_configs'::regclass
      ORDER BY conname
    `);
    const names = (rows as unknown as Array<{ conname: string }>).map((r) => r.conname);
    expect(names).toEqual([...C2C_CONFIG_HISTORY_FKS].sort());
  });

  runDb('another org cannot update it either, and the row is unchanged', async () => {
    const configId = await seedConfig();
    const other = orgAuth(f.userId, f.partnerId, f.o2);
    const ctx: DbAccessContext = { scope: 'organization', orgId: f.o2, accessibleOrgIds: [f.o2], accessiblePartnerIds: [], userId: f.userId, currentPartnerId: f.partnerId };
    const raw = await withDbAccessContext(ctx, () => tools.get('manage_c2c_configs')!.handler({ action: 'update', configId, name: 'Hijacked' }, other));
    expect(JSON.parse(raw)).toMatchObject({ code: 'NOT_FOUND' });
    const [row] = await db().select().from(c2cBackupConfigs).where(eq(c2cBackupConfigs.id, configId));
    expect(row!.name).toBe('W17 config');
  });

  runDb('another org cannot delete it, and learns nothing about it', async () => {
    const configId = await seedConfig();
    const other = orgAuth(f.userId, f.partnerId, f.o2);
    const ctx: DbAccessContext = { scope: 'organization', orgId: f.o2, accessibleOrgIds: [f.o2], accessiblePartnerIds: [], userId: f.userId, currentPartnerId: f.partnerId };
    const raw = await withDbAccessContext(ctx, () => tools.get('manage_c2c_configs')!.handler({ action: 'delete', configId }, other));
    expect(JSON.parse(raw)).toMatchObject({ code: 'NOT_FOUND' });
    expect(await configExists(configId)).toBe(true);
  });
});
