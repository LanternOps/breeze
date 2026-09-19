/** Real-database contract consumed by Devices and Alerts (RMM-QA-153). */
import './setup';
import { getAppDb } from './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { filterRoutes } from '../../routes/filters';
import { createIntegrationTestClient, createSite } from './db-utils';

const conditions = { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] };
const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('complete filter device IDs', () => {
  runDb('returns all matches past the preview cap through breeze_app and excludes another tenant', async () => {
    const app = new Hono().route('/filters', filterRoutes);
    const own = await createIntegrationTestClient(app, { scope: 'partner' });
    const foreign = await createIntegrationTestClient(app, { scope: 'partner' });
    const ownSite = await createSite({ orgId: own.env.organization.id });
    const foreignSite = await createSite({ orgId: foreign.env.organization.id });
    const ids = Array.from({ length: 125 }, () => randomUUID());
    const foreignId = randomUUID();
    await withSystemDbAccessContext(() => db.insert(devices).values([
      ...ids.map((id, i) => ({ id, orgId: own.env.organization.id, siteId: ownSite.id,
        agentId: id, hostname: `filter-match-${i}`, status: 'online' as const,
        osType: 'linux' as const, osVersion: 'test', architecture: 'x86_64', agentVersion: 'test' })),
      { id: foreignId, orgId: foreign.env.organization.id, siteId: foreignSite.id,
        agentId: foreignId, hostname: 'foreign-filter-match', status: 'online' as const,
        osType: 'linux' as const, osVersion: 'test', architecture: 'x86_64', agentVersion: 'test' },
    ]));
    const roles = await getAppDb().execute(sql`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(roles[0]).toMatchObject({ role: 'breeze_app', rolsuper: false, rolbypassrls: false });
    const response = await own.post('/filters/preview', { conditions, idsOnly: true });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.totalCount).toBe(125);
    expect(new Set(data.deviceIds)).toEqual(new Set(ids));
    expect(data.deviceIds).not.toContain(foreignId);
    expect(data.devices).toBeUndefined();
    const denied = await own.post(`/filters/preview?orgId=${foreign.env.organization.id}`, { conditions, idsOnly: true });
    expect(denied.status).toBe(403);
    const empty = await own.post('/filters/preview', {
      conditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'no-match' }] }, idsOnly: true,
    });
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toMatchObject({ totalCount: 0, deviceIds: [] });
  });
});
