import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Server-side distinct software-name search for the device-filter picker
 * (issue #1459). GET /software-inventory/names?q=... runs a bounded
 * `SELECT DISTINCT name ... WHERE name ILIKE '%q%' ORDER BY name LIMIT 50`
 * inside the request's RLS transaction.
 *
 * Org isolation is enforced by row-level security on `software_inventory`
 * (shape 1, direct org_id — see rls-coverage.integration.test.ts), not by an
 * app-layer org filter, so the route deliberately adds no org predicate. These
 * unit tests mock the DB away; they assert the route's own contract: distinct
 * matching names, the 50-row cap, LIKE-wildcard escaping, and that the query
 * runs under a transaction-local statement_timeout.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    transaction: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  configPolicyAssignments: {},
  configPolicyFeatureLinks: {},
  configurationPolicies: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  softwareInventory: {
    name: 'softwareInventory.name',
  },
  softwarePolicies: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (id: string) => id === '11111111-1111-1111-1111-111111111111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));

import { softwareInventoryRoutes } from './softwareInventory';
import { db } from '../db';

function dumpSql(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);
  const parts: string[] = [value.constructor?.name ?? 'Object'];
  for (const key of Reflect.ownKeys(value)) {
    const prop = (value as Record<PropertyKey, unknown>)[key];
    parts.push(String(key), dumpSql(prop, seen));
  }
  return parts.join(' ');
}

describe('GET /software-inventory/names', () => {
  let app: Hono;
  // Captures the SQL passed to tx.execute inside the bounded transaction.
  let executedSql: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    executedSql = [];
    app = new Hono();
    app.route('/software-inventory', softwareInventoryRoutes);
  });

  // Wire db.transaction(cb) -> cb(tx); the first tx.execute is the
  // set_config('statement_timeout', …) call, the second is the DISTINCT query
  // whose resolved value `rows` becomes the response.
  function mockTransaction(rows: Array<{ name: string }>) {
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
      const tx = {
        execute: vi.fn((sql: unknown) => {
          executedSql.push(sql);
          // First execute = set_config (return value unused); second = query rows.
          return Promise.resolve(executedSql.length === 1 ? [] : rows);
        }),
      };
      return cb(tx);
    });
  }

  it('returns matching distinct names as a string array', async () => {
    mockTransaction([{ name: 'Google Chrome' }, { name: 'Google Drive' }]);

    const res = await app.request('/software-inventory/names?q=google', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ['Google Chrome', 'Google Drive'] });
  });

  it('runs the query under a transaction-local statement_timeout', async () => {
    mockTransaction([{ name: 'Firefox' }]);

    await app.request('/software-inventory/names?q=fire', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(executedSql).toHaveLength(2);
    expect(dumpSql(executedSql[0])).toContain('statement_timeout');
    const querySql = dumpSql(executedSql[1]);
    expect(querySql).toContain('DISTINCT');
    expect(querySql).toContain('ILIKE');
  });

  it('escapes LIKE wildcards in the search term', async () => {
    mockTransaction([]);

    await app.request(`/software-inventory/names?q=${encodeURIComponent('50%_off')}`, {
      headers: { Authorization: 'Bearer token' },
    });

    // escapeLike turns %/_ into \% / \_ so they match literally, not as wildcards.
    const querySql = dumpSql(executedSql[1]);
    expect(querySql).toContain('%50\\%\\_off%');
  });

  it('caps the LIMIT at 50 even when a larger limit is requested', async () => {
    mockTransaction([]);

    const res = await app.request('/software-inventory/names?q=a&limit=500', {
      headers: { Authorization: 'Bearer token' },
    });

    // zod clamps via max(50); an over-cap value fails validation → 400, so the
    // picker never asks the DB for more than the cap.
    expect(res.status).toBe(400);
  });

  it('defaults the LIMIT to 50 when none is supplied', async () => {
    mockTransaction([]);

    await app.request('/software-inventory/names?q=a', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(dumpSql(executedSql[1])).toContain('50');
  });

  it('rejects an empty query', async () => {
    mockTransaction([]);

    const res = await app.request('/software-inventory/names?q=', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
