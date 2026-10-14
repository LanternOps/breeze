/** Real-database contract for the Device Group (groupId) filter field (#8760). */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { filterRoutes } from '../../routes/filters';
import { createIntegrationTestClient, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('groupId filter against Postgres (#8760)', () => {
  runDb('resolves group members for equals and in, and never 500s on a non-UUID value', async () => {
    const app = new Hono().route('/filters', filterRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const member = randomUUID();
    const other = randomUUID();
    const secondMember = randomUUID();
    const groupId = randomUUID();
    const secondGroupId = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.insert(devices).values([member, other, secondMember].map((id, i) => ({
        id, orgId, siteId: site.id, agentId: id, hostname: `group-filter-${i}`,
        status: 'online' as const, osType: 'windows' as const, osVersion: 'test',
        architecture: 'x86_64', agentVersion: 'test',
      })));
      await db.insert(deviceGroups).values([
        { id: groupId, orgId, name: 'Cash Registers', type: 'static' as const },
        { id: secondGroupId, orgId, name: 'Back Office', type: 'static' as const },
      ]);
      await db.insert(deviceGroupMemberships).values([
        { deviceId: member, groupId, orgId },
        { deviceId: secondMember, groupId: secondGroupId, orgId },
      ]);
    });

    // idsOnly runs evaluateFilter; the default preview runs
    // evaluateFilterWithPreview. Both must work, so every case runs through both.
    const preview = async (operator: string, value: unknown) => {
      const conditions = { operator: 'AND', conditions: [{ field: 'groupId', operator, value }] };
      const ids = await client.post('/filters/preview', { conditions, idsOnly: true });
      const full = await client.post('/filters/preview', { conditions });
      expect(full.status).toBe(ids.status);
      if (ids.status !== 200) return { status: ids.status, data: undefined };
      const idsData = (await ids.json()).data;
      const fullData = (await full.json()).data;
      expect(fullData.totalCount).toBe(idsData.totalCount);
      expect(new Set(fullData.devices.map((d: { id: string }) => d.id))).toEqual(new Set(idsData.deviceIds));
      return { status: ids.status, data: idsData };
    };

    // The Groups page "View devices" link sends exactly this shape.
    const single = await preview('in', [groupId]);
    expect(single.status).toBe(200);
    expect(single.data.deviceIds).toEqual([member]);

    const both = await preview('in', [groupId, secondGroupId]);
    expect(both.status).toBe(200);
    expect(new Set(both.data.deviceIds)).toEqual(new Set([member, secondMember]));

    const eq = await preview('equals', groupId);
    expect(eq.status).toBe(200);
    expect(eq.data.deviceIds).toEqual([member]);

    // A group NAME where an id belongs matches nothing instead of a 22P02 500.
    const byName = await preview('equals', 'Cash Registers');
    expect(byName.status).toBe(200);
    expect(byName.data.deviceIds).toEqual([]);

    const nameInList = await preview('in', ['Cash Registers', groupId]);
    expect(nameInList.status).toBe(200);
    expect(nameInList.data.deviceIds).toEqual([member]);
  });

  runDb('tags hasAny and hasAll bind a real text[] (#8760 review)', async () => {
    const app = new Hono().route('/filters', filterRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const both = randomUUID();
    const one = randomUUID();
    await withSystemDbAccessContext(() => db.insert(devices).values([
      { id: both, tags: ['idf-1', 'pos'] }, { id: one, tags: ['idf-1'] },
    ].map((d, i) => ({
      ...d, orgId, siteId: site.id, agentId: d.id, hostname: `tag-filter-${i}`,
      status: 'online' as const, osType: 'windows' as const, osVersion: 'test',
      architecture: 'x86_64', agentVersion: 'test',
    }))));
    const run = async (operator: string, value: string[]) => {
      const res = await client.post('/filters/preview', {
        conditions: { operator: 'AND', conditions: [{ field: 'tags', operator, value }] },
        idsOnly: true,
      });
      expect(res.status).toBe(200);
      return new Set((await res.json()).data.deviceIds);
    };
    expect(await run('hasAny', ['idf-1', 'nope'])).toEqual(new Set([both, one]));
    expect(await run('hasAny', ['pos'])).toEqual(new Set([both]));
    expect(await run('hasAll', ['idf-1', 'pos'])).toEqual(new Set([both]));
    expect(await run('hasAll', ['idf-1'])).toEqual(new Set([both, one]));
  });
});
