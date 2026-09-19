/** RMM-QA-162: real JWT/key authorization, Redis invalidation and normalized values. */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { apiKeys, auditLogs, customFieldDefinitions, deviceCustomFieldValues, devices, organizationUsers, servicePrincipals } from '../../db/schema';
import { customFieldValuesRoutes } from '../../routes/devices/customFieldValues';
import { getRedis } from '../../services/redis';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const app = new Hono().route('/devices', customFieldValuesRoutes);
const sys = withSystemDbAccessContext;

async function fixture() {
  const env = await setupTestEnvironment({ rolePermissions: [
    { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'write' },
  ] });
  const otherSite = await createSite({ orgId: env.organization.id });
  const rows = await sys(() => db.insert(devices).values([env.site, otherSite].map((site) => ({
    orgId: env.organization.id, siteId: site.id, agentId: randomUUID(), hostname: `site-${site.id}`,
    osType: 'linux' as const, osVersion: 'test', architecture: 'x86_64', agentVersion: 'test',
  }))).returning());
  const [definition] = await sys(() => db.insert(customFieldDefinitions).values({
    orgId: env.organization.id, fieldKey: 'asset_note', name: 'Asset note', type: 'text',
  }).returning());
  await sys(() => db.insert(deviceCustomFieldValues).values(rows.map((device) => ({
    orgId: env.organization.id, deviceId: device.id, definitionId: definition!.id,
    fieldKey: 'asset_note', valueText: 'original-site-marker', source: 'manual',
  }))));
  const rawKey = `brz_${randomBytes(24).toString('hex')}`;
  const [key] = await sys(() => db.insert(apiKeys).values({
    orgId: env.organization.id, createdBy: env.user.id, name: 'site acceptance',
    keyHash: createHash('sha256').update(rawKey).digest('hex'), keyPrefix: rawKey.slice(0, 12),
    scopes: ['devices:read', 'devices:write'], status: 'active',
  }).returning());
  const request = (deviceId: string, method = 'GET', session = false) => app.request(`/devices/${deviceId}/custom-fields`, {
    method, headers: { ...(session ? { Authorization: `Bearer ${env.token}` } : { 'X-API-Key': rawKey }),
      'Content-Type': 'application/json' },
    ...(method === 'PATCH' ? { body: JSON.stringify({ asset_note: 'updated-note' }) } : {}),
  });
  const restrict = async (siteIds: string[]) => {
    await getTestDb().update(organizationUsers).set({ siteIds })
      .where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id)));
    // Match production membership updates: invalidate Redis's versioned cache,
    // so this proves the next request uses the new scope, not the five-minute TTL.
    const redis = getRedis();
    expect(redis).not.toBeNull();
    const versionKey = `permission-cache:user-version:${env.user.id}`;
    const before = Number(await redis!.get(versionKey) ?? 0);
    await clearPermissionCache(env.user.id);
    expect(Number(await redis!.get(versionKey))).toBe(before + 1);
  };
  return { env, own: rows[0]!, other: rows[1]!, key: key!, request, restrict };
}

describe('delegated API key device site authorization', () => {
  it('matches session denial and blocks normalized writes and audit side effects', async () => {
    const f = await fixture();
    const roles = await getAppDb().execute(sql`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(roles[0]).toMatchObject({ role: 'breeze_app', rolsuper: false, rolbypassrls: false });
    await f.restrict([f.env.site.id]);
    for (const session of [false, true]) {
      const denied = await f.request(f.other.id, 'GET', session);
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain('original-site-marker');
    }
    const before = await sys(() => db.select().from(deviceCustomFieldValues).where(eq(deviceCustomFieldValues.deviceId, f.other.id)));
    const deniedWrite = await f.request(f.other.id, 'PATCH');
    expect(deniedWrite.status).toBe(403);
    const after = await sys(() => db.select().from(deviceCustomFieldValues).where(eq(deviceCustomFieldValues.deviceId, f.other.id)));
    expect(after).toEqual(before);
    const audit = await sys(() => db.select().from(auditLogs).where(and(eq(auditLogs.orgId, f.env.organization.id), eq(auditLogs.action, 'device.custom_field.update'))));
    expect(audit).toEqual([]);
    const allowed = await f.request(f.own.id, 'PATCH');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ customFields: { asset_note: 'updated-note' } });
    const allowedAudit = await sys(() => db.select().from(auditLogs).where(and(eq(auditLogs.orgId, f.env.organization.id), eq(auditLogs.action, 'device.custom_field.update'))));
    expect(allowedAudit).toHaveLength(1);
    expect(allowedAudit[0]).toMatchObject({ actorType: 'api_key', actorId: f.key.id });
  });

  it('applies a post-mint restriction, including deny-all, on the next request', async () => {
    const f = await fixture();
    expect((await f.request(f.other.id)).status).toBe(200); // warm real permission cache
    await f.restrict([f.env.site.id]);
    expect((await f.request(f.other.id)).status).toBe(403);
    expect((await f.request(f.own.id)).status).toBe(200);
    await f.restrict([]);
    expect((await f.request(f.own.id)).status).toBe(403);
    expect((await f.request(f.own.id, 'PATCH')).status).toBe(403);
  });

  it('keeps foreign-organization devices inaccessible for reads and writes', async () => {
    const caller = await fixture();
    const foreign = await fixture();
    for (const method of ['GET', 'PATCH']) {
      const result = await caller.request(foreign.own.id, method);
      expect(result.status).toBe(404);
      expect(await result.text()).not.toContain('original-site-marker');
    }
    const value = await sys(() => db.select({ value: deviceCustomFieldValues.valueText })
      .from(deviceCustomFieldValues).where(eq(deviceCustomFieldValues.deviceId, foreign.own.id)));
    expect(value).toEqual([{ value: 'original-site-marker' }]);
  });

  it('preserves intentional org-wide service-principal authority and its lifecycle gate', async () => {
    const f = await fixture();
    const [principal] = await sys(() => db.insert(servicePrincipals).values({
      orgId: f.env.organization.id, createdBy: f.env.user.id, name: 'org automation',
      scopes: ['devices:read', 'devices:write'], status: 'active',
    }).returning());
    await sys(() => db.update(apiKeys).set({ principalType: 'service', principalId: principal!.id }).where(eq(apiKeys.id, f.key.id)));
    await f.restrict([]);
    expect((await f.request(f.other.id)).status).toBe(200);
    expect((await f.request(f.other.id, 'PATCH')).status).toBe(200);
    await sys(() => db.update(servicePrincipals).set({ status: 'disabled' }).where(eq(servicePrincipals.id, principal!.id)));
    expect((await f.request(f.other.id)).status).toBe(401);
  });
});
