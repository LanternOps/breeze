import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_A = '55555555-5555-4555-8555-555555555555';
const DEVICE_B = '66666666-6666-4666-8666-666666666666';
const LAST_SEEN = new Date('2026-09-30T10:15:00.000Z');

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  accessibleOrgIds: [] as string[],
}));
vi.mock('../../db', () => ({
  db: { select: mocks.select, execute: mocks.execute },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));

import { partnerApiRoutes } from './index';
import { decodePartnerExportCursor, encodePartnerExportCursor } from './cursor';
import { partnerDeviceStatusEnvelopeSchema } from './schemas';

type QueryResult = unknown[] | Error;
let selectResults: QueryResult[] = [];
let whereArgs: SQL[] = [];
let selections: Record<string, unknown>[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn((arg: SQL) => { whereArgs.push(arg); return builder; }),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
  };
  return builder;
}

function renderedWhere(index = 0): { sql: string; params: unknown[] } {
  const rendered = new PgDialect().sqlToQuery(whereArgs[index]!);
  return { sql: rendered.sql.toLowerCase(), params: rendered.params };
}

function deviceRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceId: id, orgId: ORG_ID, siteId: SITE_ID, status: 'online',
    lastSeenAt: LAST_SEEN, agentVersion: '0.118.2',
    ...overrides,
  };
}

function request(path: string, scope = 'device-status:read', apiKey = 'test-key') {
  return app.request(path, { headers: { 'X-API-Key': apiKey, 'X-Test-Scopes': scope } });
}

let app: Hono;
describe('partner device status feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    whereArgs = [];
    selections = [];
    mocks.accessibleOrgIds = [ORG_ID, OTHER_ORG_ID];
    mocks.select.mockImplementation((selection: Record<string, unknown>) => {
      selections.push(selection);
      return query(selectResults.shift() ?? []);
    });
    app = new Hono();
    app.route('/partner-api', partnerApiRoutes);
  });

  it('requires authentication and the opt-in device-status:read scope (devices:read is not enough)', async () => {
    expect((await request('/partner-api/device-status', '', 'missing')).status).toBe(401);
    expect((await request('/partner-api/device-status', 'devices:read')).status).toBe(403);
    expect((await request('/partner-api/device-status', 'devices:read,inventory:read,alerts:read')).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns the live-state DTO with no revision, sourceUpdatedAt or snapshot fields', async () => {
    selectResults.push([
      deviceRow(DEVICE_A),
      deviceRow(DEVICE_B, { orgId: OTHER_ORG_ID, status: 'decommissioned', lastSeenAt: null }),
    ]);
    const response = await request('/partner-api/device-status');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(partnerDeviceStatusEnvelopeSchema.parse(body)).toEqual({
      schemaVersion: '1',
      data: [
        {
          deviceId: DEVICE_A, orgId: ORG_ID, siteId: SITE_ID, status: 'online',
          lastSeenAt: LAST_SEEN.toISOString(), agentVersion: '0.118.2',
        },
        {
          deviceId: DEVICE_B, orgId: OTHER_ORG_ID, siteId: SITE_ID, status: 'decommissioned',
          lastSeenAt: null, agentVersion: '0.118.2',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(body).not.toHaveProperty('snapshotAt');
    expect(body.data[0]).not.toHaveProperty('revision');
    expect(body.data[0]).not.toHaveProperty('sourceUpdatedAt');
    expect(Object.keys(selections[0]!).sort()).toEqual(
      ['agentVersion', 'createdAt', 'deviceId', 'lastSeenAt', 'orgId', 'siteId', 'status'],
    );
  });

  it('never takes partner-export read locks or reads watermark columns', async () => {
    selectResults.push([deviceRow(DEVICE_A)]);
    expect((await request('/partner-api/device-status')).status).toBe(200);
    // acquirePartnerExportReadLocks is a db.execute; this feed must not call it.
    expect(mocks.execute).not.toHaveBeenCalled();
    const where = renderedWhere();
    expect(where.sql).not.toContain('partner_export_updated_at');
  });

  it('scopes to the principal org set, excludes ephemeral devices and orders by device id', async () => {
    selectResults.push([]);
    expect((await request('/partner-api/device-status')).status).toBe(200);
    const where = renderedWhere();
    expect(where.sql).toContain('"devices"."org_id" in');
    expect(where.params).toEqual(expect.arrayContaining([ORG_ID, OTHER_ORG_ID]));
    expect(where.sql).toContain('"devices"."is_ephemeral" =');
    expect(where.sql).toContain('"devices"."created_at" <=');
  });

  it('returns an empty envelope without querying when the principal reaches no orgs', async () => {
    mocks.accessibleOrgIds = [];
    const body = await (await request('/partner-api/device-status')).json();
    expect(partnerDeviceStatusEnvelopeSchema.parse(body)).toEqual({
      schemaVersion: '1', data: [], nextCursor: null, hasMore: false,
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('404s an orgId outside the principal and narrows to an accessible orgId', async () => {
    const foreign = await request(`/partner-api/device-status?orgId=${FOREIGN_ORG_ID}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: 'partner_export_org_not_found' });
    expect(mocks.select).not.toHaveBeenCalled();

    selectResults.push([]);
    expect((await request(`/partner-api/device-status?orgId=${ORG_ID}`)).status).toBe(200);
    const where = renderedWhere();
    expect(where.params).toContain(ORG_ID);
    expect(where.params).not.toContain(OTHER_ORG_ID);
  });

  it('filters by siteId and by a status list', async () => {
    selectResults.push([]);
    expect((await request(`/partner-api/device-status?siteId=${SITE_ID}&status=offline,online`)).status).toBe(200);
    const where = renderedWhere();
    expect(where.sql).toContain('"devices"."site_id" =');
    expect(where.sql).toContain('"devices"."status" in');
    expect(where.params).toEqual(expect.arrayContaining([SITE_ID, 'offline', 'online']));
  });

  it('rejects invalid filters and unsupported parameters before querying', async () => {
    for (const suffix of [
      '?orgId=nope', '?siteId=nope', '?limit=-1', '?limit=abc', '?status=asleep', '?status=',
      '?cursor=bad', '?updatedSince=2026-09-01T00:00:00.000Z', '?since=abc',
    ]) {
      const response = await request(`/partner-api/device-status${suffix}`);
      expect(response.status, suffix).toBe(400);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('pages by device id with a signed cursor bound to partner, resource and filters', async () => {
    selectResults.push([deviceRow(DEVICE_A), deviceRow(DEVICE_B)]);
    const first = await (await request('/partner-api/device-status?limit=1&status=online')).json();
    expect(first.hasMore).toBe(true);
    expect(first.data).toHaveLength(1);
    expect(first.data[0].deviceId).toBe(DEVICE_A);
    const cursor = decodePartnerExportCursor(first.nextCursor, {
      partnerId: PARTNER_ID,
      resource: 'device-status',
      updatedSince: null,
      filters: { orgId: null, siteId: null, status: 'online' },
    });
    expect(cursor.lastId).toBe(DEVICE_A);

    selectResults.push([deviceRow(DEVICE_B)]);
    const second = await (await request(
      `/partner-api/device-status?limit=1&status=online&cursor=${encodeURIComponent(first.nextCursor)}`,
    )).json();
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.data.map((row: { deviceId: string }) => row.deviceId)).toEqual([DEVICE_B]);
    const where = renderedWhere(1);
    expect(where.sql).toContain('"devices"."id" >');
    expect(where.params).toContain(DEVICE_A);

    // A cursor replayed with different filters, or minted for another
    // resource, is rejected rather than silently mixing traversals.
    for (const path of [
      `/partner-api/device-status?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      `/partner-api/device-status?limit=1&status=offline&cursor=${encodeURIComponent(first.nextCursor)}`,
      `/partner-api/device-status?limit=1&status=online&cursor=${encodeURIComponent(
        encodePartnerExportCursor({ ...cursor, resource: 'devices' }),
      )}`,
    ]) {
      const response = await request(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_partner_export_cursor' });
    }
  });

  it('rejects a cursor minted for another partner', async () => {
    selectResults.push([deviceRow(DEVICE_A), deviceRow(DEVICE_B)]);
    const first = await (await request('/partner-api/device-status?limit=1')).json();
    const decoded = decodePartnerExportCursor(first.nextCursor, {
      partnerId: PARTNER_ID, resource: 'device-status', updatedSince: null,
      filters: { orgId: null, siteId: null, status: null },
    });
    const forged = encodePartnerExportCursor({ ...decoded, partnerId: FOREIGN_ORG_ID });
    const response = await request(`/partner-api/device-status?cursor=${encodeURIComponent(forged)}`);
    expect(response.status).toBe(400);
  });

  it('fails closed with a generic 500 on a database error', async () => {
    selectResults.push(new Error('connection reset'));
    const response = await request('/partner-api/device-status');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Partner device status export failed.', code: 'partner_export_failed' });
  });
});
