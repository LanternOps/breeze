import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { devices, localVaults, organizationUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { vaultRoutes } from '../../routes/backup/vault';
import { createAccessToken } from '../../services/jwt';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/backup/vault', vaultRoutes);
  return app;
}

async function mfaToken(
  env: Awaited<ReturnType<typeof setupTestEnvironment>>,
  scope: 'organization' | 'partner' = 'organization',
): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: scope === 'organization' ? env.organization.id : null,
    partnerId: env.partner.id,
    scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `vault-site-${label}-${randomUUID()}`,
    hostname: `vault-${label}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'x64',
    agentVersion: 'test',
    status: 'online',
  }).returning({ id: devices.id });
  if (!row) throw new Error('device fixture insert failed');
  return row.id;
}

async function seedVault(orgId: string, deviceId: string, path: string): Promise<string> {
  const [row] = await getTestDb().insert(localVaults).values({
    orgId,
    deviceId,
    vaultPath: path,
    vaultType: 'local',
    retentionCount: 3,
  }).returning({ id: localVaults.id });
  if (!row) throw new Error('vault fixture insert failed');
  return row.id;
}

async function loadVault(id: string) {
  const [row] = await getTestDb().select({
    vaultPath: localVaults.vaultPath,
    isActive: localVaults.isActive,
  }).from(localVaults).where(eq(localVaults.id, id)).limit(1);
  return row;
}

describe('local-vault mutations enforce the current device site', () => {
  runDb('allows the selected site and opaquely denies a hidden site before effects', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id });
    await getTestDb().update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id));

    const allowedDevice = await seedDevice(env.organization.id, env.site.id, 'allowed');
    const hiddenDevice = await seedDevice(env.organization.id, hiddenSite.id, 'hidden');
    const allowedVault = await seedVault(env.organization.id, allowedDevice, '/allowed');
    const hiddenVault = await seedVault(env.organization.id, hiddenDevice, '/hidden');
    const token = await mfaToken(env);
    const app = buildApp();

    const allowed = await app.request(`/backup/vault/${allowedVault}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: JSON.stringify({ vaultPath: '/allowed-updated' }),
    });
    expect(allowed.status).toBe(200);

    const hiddenPatch = await app.request(`/backup/vault/${hiddenVault}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: JSON.stringify({ vaultPath: '/hidden-mutated' }),
    });
    expect(hiddenPatch.status).toBe(404);
    expect(await hiddenPatch.json()).toEqual({ error: 'Vault not found' });

    const hiddenDelete = await app.request(`/backup/vault/${hiddenVault}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(hiddenDelete.status).toBe(404);
    expect(await hiddenDelete.json()).toEqual({ error: 'Vault not found' });

    expect(await loadVault(allowedVault)).toEqual({ vaultPath: '/allowed-updated', isActive: true });
    expect(await loadVault(hiddenVault)).toEqual({ vaultPath: '/hidden', isActive: true });

    const foreign = await setupTestEnvironment({ scope: 'organization' });
    const foreignDevice = await seedDevice(foreign.organization.id, foreign.site.id, 'foreign');
    const foreignVault = await seedVault(foreign.organization.id, foreignDevice, '/foreign');
    const crossOrg = await app.request(`/backup/vault/${foreignVault}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(crossOrg.status).toBe(404);
    expect(await loadVault(foreignVault)).toEqual({ vaultPath: '/foreign', isActive: true });
  });

  runDb('denies an empty site ceiling without changing the vault', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    await getTestDb().update(organizationUsers)
      .set({ siteIds: [] })
      .where(eq(organizationUsers.userId, env.user.id));
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'empty');
    const vaultId = await seedVault(env.organization.id, deviceId, '/empty');
    const token = await mfaToken(env);
    const app = buildApp();

    const response = await app.request(`/backup/vault/${vaultId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: JSON.stringify({ vaultPath: '/must-not-write' }),
    });

    expect(response.status).toBe(404);
    expect(await loadVault(vaultId)).toEqual({ vaultPath: '/empty', isActive: true });
  });

  runDb('preserves unrestricted organization mutation behavior', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const otherSite = await createSite({ orgId: env.organization.id });
    const deviceId = await seedDevice(env.organization.id, otherSite.id, 'unrestricted');
    const vaultId = await seedVault(env.organization.id, deviceId, '/unrestricted');
    const token = await mfaToken(env);
    const app = buildApp();

    const response = await app.request(`/backup/vault/${vaultId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await loadVault(vaultId)).toEqual({ vaultPath: '/unrestricted', isActive: false });
  });

  runDb('preserves unrestricted partner mutation behavior for an accessible organization', async () => {
    const env = await setupTestEnvironment({
      scope: 'partner',
      rolePermissions: [{ resource: 'organizations', action: 'write' }],
    });
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'partner');
    const vaultId = await seedVault(env.organization.id, deviceId, '/partner');
    const token = await mfaToken(env, 'partner');
    const app = buildApp();

    const response = await app.request(`/backup/vault/${vaultId}?orgId=${env.organization.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
      body: JSON.stringify({ retentionCount: 9 }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).retentionCount).toBe(9);
  });
});
