import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

// Tests for the manual arm of the unified Devices list (#4622 W02):
// GET/POST/PATCH/DELETE /devices/manual plus link/unlink. Mirrors
// network.test.ts's mock shape (the network arm is the closest sibling).

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

let accessibleOrgIds: string[] = ['org-1'];
let allowedSiteIds: string[] | undefined = undefined;
let mfaSatisfied = true;

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds,
      canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId),
      orgCondition: () => undefined,
      token: { mfa: mfaSatisfied },
    });
    c.set('permissions', {
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'delete' },
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    return next();
  }),
  // Mirrors the real gate's contract (middleware/auth.ts requireMfa): a session
  // whose token lacks the `mfa` claim is refused with the coded 403 body, so
  // the tests below can prove every mutator is gated and the read is not.
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')?.token?.mfa) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    return next();
  }),
}));

const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

import { manualRoutes } from './manual';
import { db } from '../../db';
import { readFileSync } from 'fs';
import { join } from 'path';

const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DISC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function baseManualRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    orgId: ORG_1,
    siteId: SITE_A,
    name: 'Spare laptop',
    assetType: 'workstation',
    manufacturer: 'Dell',
    model: 'Latitude 5420',
    serialNumber: 'SN-123',
    assetTag: 'TAG-1',
    location: 'Closet B',
    assignedContactId: null,
    source: 'manual',
    linkedDeviceId: null,
    linkedDiscoveredAssetId: null,
    notes: null,
    tags: [],
    retiredAt: null,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Rig a chained SELECT that resolves to `rows` and records the WHERE arg. */
function rigSelect(rows: unknown[]) {
  const captured: unknown[] = [];
  const orderBy = vi.fn().mockReturnValue({
    limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
  });
  const where = vi.fn().mockImplementation((cond: unknown) => {
    captured.push(cond);
    // Support both list-style (.where().orderBy().limit().offset()) and
    // single-row-lookup style (.where().limit() -> rows) call chains.
    return {
      orderBy,
      limit: vi.fn().mockResolvedValue(rows),
    };
  });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  return { captured };
}

/** Queue up successive SELECT calls returning different row sets in order. */
function rigSelectSequence(sequences: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const rows = sequences[Math.min(i, sequences.length - 1)];
    i += 1;
    const where = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue(rows) }),
      }),
    });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  }) as never);
}

function rigInsert(row: unknown) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values };
}

function rigInsertThrows(err: unknown) {
  const returning = vi.fn().mockRejectedValue(err);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
}

function rigUpdate(row: unknown | undefined) {
  const returning = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where };
}

function rigDelete(deletedIds: string[] = ['deleted']) {
  const returning = vi.fn().mockResolvedValue(deletedIds.map((id) => ({ id })));
  const where = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.delete).mockReturnValue({ where } as never);
  return { where, returning };
}

describe('devices/manual — manual asset CRUD + link/unlink (#4622 W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    accessibleOrgIds = [ORG_1];
    allowedSiteIds = undefined;
    app = new Hono();
    app.route('/devices', manualRoutes);
  });

  // --- POST /devices/manual -------------------------------------------------

  it('creates a manual asset (201), source="manual", writes manual_asset.create audit', async () => {
    rigSelect([{ id: SITE_A }]); // site lookup: site exists and belongs to the org
    const created = baseManualRow();
    rigInsert(created);

    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'Spare laptop' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.deviceClass).toBe('manual');
    expect(body.warnings).toBeUndefined();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'manual_asset.create',
      resourceType: 'manual_asset',
      resourceId: ASSET_ID,
    }));
  });

  it('rejects an orgId outside accessibleOrgIds with 403', async () => {
    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_2, siteId: SITE_A, name: 'X' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a siteId belonging to a different org with a clean 400 (not a raw constraint error)', async () => {
    rigSelect([]); // site lookup: no site found for (siteId, orgId) pair
    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_B, name: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('403s a site-scoped technician whose allowedSiteIds excludes the target site', async () => {
    allowedSiteIds = [SITE_B];
    rigSelect([{ id: SITE_A }]); // site exists and belongs to the org
    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'X' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site denied/i);
  });

  it('rejects an assetType outside the enum with 400', async () => {
    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'X', assetType: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('still creates (201) on a duplicate org+serial, with a non-blocking DUPLICATE_SERIAL warning', async () => {
    // Two SELECTs in order: (1) site lookup, (2) org+serial duplicate check.
    rigSelectSequence([[{ id: SITE_A }], [{ id: 'existing-row-id' }]]);
    const created = baseManualRow({ serialNumber: 'SN-123' });
    rigInsert(created);

    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'Spare laptop', serialNumber: 'SN-123' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toEqual([expect.objectContaining({ code: 'DUPLICATE_SERIAL' })]);
  });

  it('translates a cross-org assigned-contact FK violation (23503) into a clean 400', async () => {
    rigSelect([{ id: SITE_A }]); // site lookup succeeds
    rigInsertThrows(Object.assign(new Error('insert or update on table "manual_assets" violates foreign key constraint'), {
      code: '23503',
      constraint_name: 'manual_assets_assigned_contact_org_fk',
    }));

    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'X', assignedContactId: DISC_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/assigned contact/i);
  });

  it('re-throws (500) an FK violation on a DIFFERENT constraint rather than mislabeling it as a contact error', async () => {
    // #5255 review finding: a blanket `pgErrorCode === '23503'` cannot tell
    // WHICH of the table's five FKs fired. This proves the fix checks the
    // constraint name, not just the SQLSTATE.
    rigSelect([{ id: SITE_A }]);
    rigInsertThrows(Object.assign(new Error('insert or update on table "manual_assets" violates foreign key constraint'), {
      code: '23503',
      constraint_name: 'manual_assets_site_org_fk',
    }));

    // Hono's default error handler converts an uncaught throw into a 500
    // response rather than rejecting the fetch promise — assert on that,
    // not on the response body (which is deliberately not the clean,
    // user-facing "assigned contact not found" message from the branch
    // above).
    const res = await app.request('/devices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ orgId: ORG_1, siteId: SITE_A, name: 'X' }),
    });
    expect(res.status).toBe(500);
  });

  // --- GET /devices/manual ---------------------------------------------------

  it('GET excludes retired, linked-to-device, and linked-to-discovered-asset rows via the query conditions (not enum matching)', async () => {
    const { captured } = rigSelect([]);

    const res = await app.request('/devices/manual', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(captured[0]).toBeDefined();
    const sqlText = new PgDialect().sqlToQuery(captured[0] as never).sql.toLowerCase();
    expect(sqlText).toMatch(/"retired_at" is null/);
    expect(sqlText).toMatch(/"linked_device_id" is null/);
    expect(sqlText).toMatch(/"linked_discovered_asset_id" is null/);
  });

  it('GET rejects an orgId outside accessibleOrgIds with 403', async () => {
    const res = await app.request(`/devices/manual?orgId=${ORG_2}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  it('GET returns a total only when includeTotal=true', async () => {
    // Two selects: the count query, then the row query.
    let call = 0;
    vi.mocked(db.select).mockImplementation(((arg: any) => {
      const isCount = arg && typeof arg === 'object' && 'count' in arg && Object.keys(arg).length === 1;
      call += 1;
      if (isCount) {
        const where = vi.fn().mockResolvedValue([{ count: 3 }]);
        return { from: vi.fn().mockReturnValue({ where }) };
      }
      const orderBy = vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([]) }) });
      const where = vi.fn().mockReturnValue({ orderBy });
      return { from: vi.fn().mockReturnValue({ where }) };
    }) as never);

    const res = await app.request('/devices/manual?includeTotal=true', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.total).toBe(3);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('403s a site-restricted GET caller requesting a site outside their allowlist', async () => {
    allowedSiteIds = [SITE_A];
    rigSelect([]);

    const res = await app.request(`/devices/manual?siteId=${SITE_B}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site denied/i);
  });

  it('GET DTO shape: deviceClass=manual, status=unknown, agent/network fields null, enrolledAt=createdAt', async () => {
    rigSelect([baseManualRow()]);

    const res = await app.request('/devices/manual', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    expect(row.deviceClass).toBe('manual');
    expect(row.status).toBe('unknown');
    expect(row.ipAddress).toBeNull();
    expect(row.macAddress).toBeNull();
    expect(row.agentId).toBeNull();
    expect(row.enrolledAt).toBe(new Date('2026-06-01T00:00:00.000Z').toISOString());
  });

  // --- POST /devices/manual/:id/link -----------------------------------------

  it('400s POST /:id/link when both deviceId and discoveredAssetId are provided', async () => {
    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID, discoveredAssetId: DISC_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('400s POST /:id/link when NEITHER deviceId nor discoveredAssetId is provided', async () => {
    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('403s POST /:id/link for a site-scoped technician whose allowlist excludes the asset\'s own site', async () => {
    allowedSiteIds = [SITE_B];
    rigSelectSequence([[baseManualRow({ siteId: SITE_A })]]);

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
  });

  it('404s POST /:id/link when the target device belongs to another org (never leaks existence)', async () => {
    rigSelectSequence([
      [baseManualRow()], // load existing manual asset
      [{ id: DEVICE_ID, orgId: ORG_2, siteId: SITE_A }], // device in a different org
    ]);

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).not.toMatch(/organization/i);
  });

  it('400s POST /:id/link when the device is in the same org but a different site', async () => {
    rigSelectSequence([
      [baseManualRow()],
      [{ id: DEVICE_ID, orgId: ORG_1, siteId: SITE_B }],
    ]);

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(400);
  });

  it('links to a device in the same org+site (200) and writes manual_asset.link audit', async () => {
    rigSelectSequence([
      [baseManualRow()],
      [{ id: DEVICE_ID, orgId: ORG_1, siteId: SITE_A }],
    ]);
    rigUpdate(baseManualRow({ linkedDeviceId: DEVICE_ID }));

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'manual_asset.link',
    }));
  });

  it('404s POST /:id/link on a 0-row write (lost race with a concurrent delete/re-org), not 500', async () => {
    rigSelectSequence([
      [baseManualRow()],
      [{ id: DEVICE_ID, orgId: ORG_1, siteId: SITE_A }],
    ]);
    rigUpdate(undefined); // update matches nothing

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(404);
  });

  // --- PATCH /devices/manual/:id ----------------------------------------------

  it('PATCH updates fields and writes manual_asset.update audit', async () => {
    rigSelectSequence([[baseManualRow()]]);
    rigUpdate(baseManualRow({ name: 'Renamed laptop', notes: 'checked in' }));

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name: 'Renamed laptop', notes: 'checked in' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostname).toBe('Renamed laptop');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'manual_asset.update',
      resourceId: ASSET_ID,
    }));
  });

  it('PATCH 404s a manual asset in another org (never leaks existence)', async () => {
    rigSelectSequence([[baseManualRow({ orgId: ORG_2 })]]);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(res.status).toBe(404);
  });

  it('PATCH un-retires a row when retiredAt is explicitly set to null', async () => {
    rigSelectSequence([[baseManualRow({ retiredAt: new Date('2026-05-01T00:00:00.000Z') })]]);
    const { set } = rigUpdate(baseManualRow({ retiredAt: null }));

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ retiredAt: null }),
    });

    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ retiredAt: null }));
  });

  it('PATCH rejects an empty body with 400', async () => {
    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('403s PATCH for a site-scoped technician whose allowlist excludes the asset\'s CURRENT site', async () => {
    allowedSiteIds = [SITE_B];
    rigSelectSequence([[baseManualRow({ siteId: SITE_A })]]);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(res.status).toBe(403);
  });

  it('400s a PATCH site move to a site belonging to a different org', async () => {
    // First select: load the existing row. Second: target-site lookup (empty
    // — the site does not belong to the row's org).
    rigSelectSequence([[baseManualRow({ siteId: SITE_A })], []]);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ siteId: SITE_B }),
    });

    expect(res.status).toBe(400);
  });

  it('403s a PATCH site move into a site outside a site-scoped technician\'s allowlist', async () => {
    allowedSiteIds = [SITE_A]; // caller may see the CURRENT site...
    rigSelectSequence([
      [baseManualRow({ siteId: SITE_A })],
      [{ id: SITE_B }], // ...but the TARGET site is a real site in the org
    ]);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ siteId: SITE_B }),
    });

    expect(res.status).toBe(403);
  });

  it('translates a cross-org assigned-contact FK violation on PATCH into a clean 400', async () => {
    rigSelectSequence([[baseManualRow()]]);
    const returning = vi.fn().mockRejectedValue(Object.assign(
      new Error('insert or update on table "manual_assets" violates foreign key constraint'),
      { code: '23503', constraint_name: 'manual_assets_assigned_contact_org_fk' },
    ));
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }) } as never);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ assignedContactId: DISC_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/assigned contact/i);
  });

  it('404s a PATCH 0-row write (lost race), not a silent 200', async () => {
    rigSelectSequence([[baseManualRow()]]);
    rigUpdate(undefined);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(res.status).toBe(404);
  });

  // --- DELETE /devices/manual/:id/link ---------------------------------------

  it('DELETE /:id/link clears both link columns', async () => {
    rigSelectSequence([[baseManualRow({ linkedDeviceId: DEVICE_ID })]]);
    const { set } = rigUpdate(baseManualRow({ linkedDeviceId: null, linkedDiscoveredAssetId: null }));

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      linkedDeviceId: null,
      linkedDiscoveredAssetId: null,
    }));
  });

  it('403s DELETE /:id/link for a site-scoped technician outside the asset\'s allowlist', async () => {
    allowedSiteIds = [SITE_B];
    rigSelectSequence([[baseManualRow({ siteId: SITE_A, linkedDeviceId: DEVICE_ID })]]);

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
  });

  it('404s DELETE /:id/link on a 0-row write (lost race), not a silent 200', async () => {
    rigSelectSequence([[baseManualRow({ linkedDeviceId: DEVICE_ID })]]);
    rigUpdate(undefined);

    const res = await app.request(`/devices/manual/${ASSET_ID}/link`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(404);
  });

  // --- DELETE /devices/manual/:id ---------------------------------------------

  it('DELETE /:id hard-deletes and writes manual_asset.delete audit', async () => {
    rigSelectSequence([[baseManualRow()]]);
    rigDelete();

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'manual_asset.delete',
      resourceId: ASSET_ID,
    }));
  });

  it('403s DELETE /:id for a site-scoped technician outside the asset\'s allowlist', async () => {
    allowedSiteIds = [SITE_B];
    rigSelectSequence([[baseManualRow({ siteId: SITE_A })]]);

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
  });

  it('404s DELETE /:id on a 0-row delete (lost race with a concurrent delete) instead of reporting success', async () => {
    rigSelectSequence([[baseManualRow()]]);
    rigDelete([]); // the DELETE matches nothing

    const res = await app.request(`/devices/manual/${ASSET_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(404);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  // --- MFA gate on every mutator (matches device edit + discovery mutators) ---

  it('carries requireMfa() on exactly the five mutators and not on the read', () => {
    const src = readFileSync(join(__dirname, 'manual.ts'), 'utf8');
    expect((src.match(/^\s*requireMfa\(\),$/gm) ?? []).length).toBe(5);
    const getBlock = src.slice(src.indexOf('manualRoutes.get('), src.indexOf('manualRoutes.post('));
    expect(getBlock).not.toMatch(/requireMfa/);
  });

  describe('without a completed-MFA session', () => {
    beforeEach(() => {
      mfaSatisfied = false;
    });
    afterEach(() => {
      mfaSatisfied = true;
    });

    it.each([
      ['POST /devices/manual', 'POST', '/devices/manual', { orgId: 'org-1', siteId: 'site-1', name: 'x' }],
      ['PATCH /devices/manual/:id', 'PATCH', '/devices/manual/11111111-1111-4111-8111-111111111111', { name: 'y' }],
      ['DELETE /devices/manual/:id', 'DELETE', '/devices/manual/11111111-1111-4111-8111-111111111111', undefined],
      ['POST /devices/manual/:id/link', 'POST', '/devices/manual/11111111-1111-4111-8111-111111111111/link', { deviceId: '22222222-2222-4222-8222-222222222222' }],
      ['DELETE /devices/manual/:id/link', 'DELETE', '/devices/manual/11111111-1111-4111-8111-111111111111/link', undefined],
    ])('%s is refused with MFA_REQUIRED', async (_label, method, path, body) => {
      const res = await app.request(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    });

    it('GET /devices/manual still answers (reads are not step-up gated)', async () => {
      const res = await app.request('/devices/manual?orgId=org-1');
      expect(res.status).not.toBe(403);
    });
  });
});
