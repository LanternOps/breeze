/**
 * Live-Postgres coverage for the routes that hand an operator a recovery
 * credential: a recovery token (`POST /backup/bmr/tokens`), a bare-metal
 * recovery code (`POST /backup/bmr/recoveries`) and a re-issued code
 * (`POST /backup/bmr/recoveries/:id/reissue-code`). Each credential starts a
 * restore of the snapshot's device, so the routes require the same
 * device-execute permission as every other restore lane, on top of backup
 * write.
 *
 * WHY A REAL DATABASE: the decision is made by the real auth middleware
 * reading the caller's role permissions from Postgres; a mocked
 * requirePermission cannot show which permissions the route asks for.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  bareMetalRecoveries,
  recoveryTokens,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { backupRoutes } from '../../routes/backup';
import {
  assignUserToOrganization,
  createDevice,
  createRole,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { attestSnapshotForTest } from './restoreIntegrityFixture';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PROVIDER_CONFIG = { path: '/tmp/breeze-recovery-credential-permissions' };
const STORAGE_IDENTITY = normalizeStorageIdentity('local', PROVIDER_CONFIG);

const BACKUP_OPERATOR = [
  { resource: 'backup', action: 'read' },
  { resource: 'backup', action: 'write' },
  { resource: 'devices', action: 'read' },
];
const RESTORE_OPERATOR = [...BACKUP_OPERATOR, { resource: 'devices', action: 'execute' }];

const app = new Hono();
app.route('/backup', backupRoutes);

type Session = { token: string; userId: string };

async function seed() {
  const testDb = getTestDb();
  const { partner, organization, site } = await setupTestEnvironment({ rolePermissions: [] });

  async function sessionFor(perms: Array<{ resource: string; action: string }>): Promise<Session> {
    const user = await createUser({ partnerId: partner.id, orgId: organization.id, email: `rcp-${randomUUID()}@example.com` });
    const role = await createRole({ scope: 'organization', orgId: organization.id });
    await grantRolePermissions(role!.id, perms);
    await assignUserToOrganization(user.id, organization.id, role!.id);
    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role!.id,
      orgId: organization.id,
      partnerId: partner.id,
      scope: 'organization',
      mfa: true,
      mfa_src: 'factor',
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });
    return { token, userId: user.id };
  }

  const device = await createDevice({ orgId: organization.id, siteId: site.id });
  const [config] = await testDb.insert(backupConfigs).values({
    orgId: organization.id,
    name: `rcp-${randomUUID().slice(0, 8)}`,
    type: 'file',
    provider: 'local',
    providerConfig: PROVIDER_CONFIG,
  }).returning({ id: backupConfigs.id });
  const [job] = await testDb.insert(backupJobs).values({
    orgId: organization.id,
    configId: config!.id,
    deviceId: device.id,
    status: 'completed',
  } as never).returning({ id: backupJobs.id });
  const [snapshot] = await testDb.insert(backupSnapshots).values({
    orgId: organization.id,
    jobId: job!.id,
    deviceId: device.id,
    snapshotId: `rcp-${randomUUID().slice(0, 8)}`,
    timestamp: new Date(),
    storageIdentity: STORAGE_IDENTITY,
    metadata: { provider: 'local', providerConfig: PROVIDER_CONFIG },
    bareMetalRestorable: true,
  } as never).returning({ id: backupSnapshots.id });
  await attestSnapshotForTest(snapshot!.id);

  return {
    snapshotId: snapshot!.id,
    backupOperator: await sessionFor(BACKUP_OPERATOR),
    restoreOperator: await sessionFor(RESTORE_OPERATOR),
  };
}

function post(session: Session, path: string, body: unknown = {}): Promise<Response> {
  return Promise.resolve(app.request(`/backup${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function tokenCount(): Promise<number> {
  const [row] = await getTestDb().select({ n: count() }).from(recoveryTokens);
  return Number(row?.n ?? 0);
}

async function recoveryCount(): Promise<number> {
  const [row] = await getTestDb().select({ n: count() }).from(bareMetalRecoveries);
  return Number(row?.n ?? 0);
}

describe('recovery credential routes require device-execute permission', () => {
  runDb('a recovery token is minted for a restore operator', async () => {
    const f = await seed();
    const res = await post(f.restoreOperator, '/bmr/tokens', { snapshotId: f.snapshotId, restoreType: 'full', expiresInHours: 1 });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await tokenCount()).toBe(1);
  });

  runDb('a backup operator without device-execute cannot mint a recovery token', async () => {
    const f = await seed();
    const res = await post(f.backupOperator, '/bmr/tokens', { snapshotId: f.snapshotId, restoreType: 'full', expiresInHours: 1 });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Permission denied');
    expect(text).not.toContain('brz_rec_');
    expect(await tokenCount()).toBe(0);
  });

  runDb('a bare-metal recovery is created for a restore operator', async () => {
    const f = await seed();
    const res = await post(f.restoreOperator, '/bmr/recoveries', { snapshotId: f.snapshotId });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await recoveryCount()).toBe(1);
  });

  runDb('a backup operator without device-execute cannot create a bare-metal recovery', async () => {
    const f = await seed();
    const res = await post(f.backupOperator, '/bmr/recoveries', { snapshotId: f.snapshotId });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Permission denied');
    expect(text).not.toContain('"code"');
    expect(await recoveryCount()).toBe(0);
  });

  runDb('a backup operator without device-execute cannot re-issue a recovery code', async () => {
    const f = await seed();
    const created = await post(f.restoreOperator, '/bmr/recoveries', { snapshotId: f.snapshotId });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json() as { id: string };
    const [before] = await getTestDb()
      .select({ codeHash: bareMetalRecoveries.codeHash, codeExpiresAt: bareMetalRecoveries.codeExpiresAt })
      .from(bareMetalRecoveries)
      .where(eq(bareMetalRecoveries.id, id));

    const res = await post(f.backupOperator, `/bmr/recoveries/${id}/reissue-code`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Permission denied');
    expect(text).not.toContain('"code"');
    const [after] = await getTestDb()
      .select({ codeHash: bareMetalRecoveries.codeHash, codeExpiresAt: bareMetalRecoveries.codeExpiresAt })
      .from(bareMetalRecoveries)
      .where(eq(bareMetalRecoveries.id, id));
    expect(after).toEqual(before);
  });

  runDb('a restore operator can re-issue a recovery code', async () => {
    const f = await seed();
    const created = await post(f.restoreOperator, '/bmr/recoveries', { snapshotId: f.snapshotId });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json() as { id: string };

    const res = await post(f.restoreOperator, `/bmr/recoveries/${id}/reissue-code`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.code).toBe('string');
  });
});
