import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { devices, organizationUsers } from '../../db/schema';
import { optionsRoutes } from '../../routes/devices/options';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/devices', optionsRoutes);
  return app;
}

function request(app: Hono, token: string, query = ''): Promise<Response> {
  return Promise.resolve(app.request(`/devices/options${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

describe('GET /devices/options — real PostgreSQL authorization and cursor matrix', () => {
  let app: Hono;

  beforeEach(() => { app = buildApp(); });

  it('does not leak foreign org/site/include metadata and traverses 10,000 authorized devices exactly once', async () => {
    const allowed = await setupTestEnvironment({ scope: 'organization' });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Foreign Secret Site' });

    // Make the org user explicitly site-restricted to its one allowed site.
    await getTestDb().update(organizationUsers)
      .set({ siteIds: [allowed.site.id] })
      .where(eq(organizationUsers.userId, allowed.user.id));

    const batch = Array.from({ length: 10_000 }, (_, index) => ({
      orgId: allowed.organization.id,
      siteId: allowed.site.id,
      agentId: `options-${randomUUID()}`,
      hostname: `fleet-${String(index).padStart(5, '0')}`,
      displayName: index % 2 === 0 ? `Node ${String(index).padStart(5, '0')}` : null,
      osType: (index % 3 === 0 ? 'linux' : index % 3 === 1 ? 'windows' : 'macos') as 'linux' | 'windows' | 'macos',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: (index % 2 === 0 ? 'online' : 'offline') as 'online' | 'offline',
      isEphemeral: false,
    }));
    const inserted: Array<{ id: string }> = [];
    for (let offset = 0; offset < batch.length; offset += 1_000) {
      inserted.push(...await getTestDb().insert(devices).values(batch.slice(offset, offset + 1_000)).returning({ id: devices.id }));
    }

    const [foreignDevice] = await getTestDb().insert(devices).values({
      orgId: foreignOrg.id,
      siteId: foreignSite.id,
      agentId: `foreign-${randomUUID()}`,
      hostname: 'foreign-secret-hostname',
      displayName: 'Foreign Secret Label',
      osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: 'test', status: 'online',
    }).returning({ id: devices.id });
    if (!foreignDevice) throw new Error('foreign device insert failed');

    for (const marker of ['fleet-00000', 'fleet-05000', 'fleet-09999']) {
      const response = await request(app, allowed.token, `?search=${marker}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.map((item: { hostname: string }) => item.hostname)).toContain(marker);
      expect(body.page.total).toBe(1);
    }

    let response = await request(app, allowed.token, '?search=foreign-secret');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], page: { returned: 0, total: 0 } });

    response = await request(app, allowed.token, `?search=no-match&includeIds=${foreignDevice.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], page: { returned: 0, total: 0 } });

    const beforeCount = (await getTestDb().select({ id: devices.id }).from(devices)).length;
    response = await request(app, allowed.token, `?siteId=${foreignSite.id}`);
    expect(response.status).toBe(403);
    const afterCount = (await getTestDb().select({ id: devices.id }).from(devices)).length;
    expect(afterCount).toBe(beforeCount);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const pageResponse = await request(app, allowed.token, suffix);
      expect(pageResponse.status).toBe(200);
      const body = await pageResponse.json();
      for (const option of body.data as Array<{ id: string }>) {
        expect(seen.has(option.id)).toBe(false);
        seen.add(option.id);
      }
      cursor = body.page.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(100);
    } while (cursor);

    expect(seen.size).toBe(10_000);
    expect(seen).toEqual(new Set(inserted.map((item) => item.id)));
  }, 120_000);
});
