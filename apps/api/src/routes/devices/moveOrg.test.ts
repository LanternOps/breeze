import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authMiddlewareMock,
  requireScopeMock,
  requirePermissionMock,
  requireMfaMock,
  siteDenied,
} = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
  requireMfa: requireMfaMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
  stripSensitiveDeviceFields: (d: any) => d,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../agentWs', () => ({
  disconnectAgent: vi.fn(() => true),
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { disconnectAgent } from '../agentWs';
import { moveOrgRoutes } from './moveOrg';
import {
  CUSTOM_ORG_REWRITE_TABLES,
  DEVICE_ORG_DENORMALIZED_TABLES,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from './core';

// Snapshot the gate registration BEFORE any `vi.clearAllMocks()` runs.
// requireScope/requirePermission/requireMfa run at module-import time as the
// route file builds its handler chain, so by the time the first test runs
// the calls are already on the mock. We capture them here so the assertions
// survive beforeEach's clearAllMocks.
const registeredScopeCalls: string[][] = (requireScopeMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.flat().map((v) => String(v)),
);
const registeredPermResources: string[] = (requirePermissionMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.map((v) => String(v)).join(':'),
);
const registeredMfaCallCount = requireMfaMock.mock.calls.length;

const SOURCE_ORG = '11111111-1111-4111-8111-111111111111';
const TARGET_ORG = '22222222-2222-4222-8222-222222222222';
const SOURCE_SITE = '33333333-3333-4333-8333-333333333333';
const TARGET_SITE = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_PARTNER_TARGET_ORG = '66666666-6666-4666-8666-666666666666';

const SAMPLE_DEVICE = {
  id: DEVICE_ID,
  agentId: 'agent-abc-123',
  orgId: SOURCE_ORG,
  siteId: SOURCE_SITE,
  hostname: 'host-1',
  displayName: 'Host One',
  status: 'online' as const,
  customFields: null,
};

function setAuth(overrides: Partial<{
  scope: 'organization' | 'partner' | 'system';
  canAccessOrg: (id: string) => boolean;
}> = {}) {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 't@example.com' },
      scope: overrides.scope ?? 'partner',
      orgId: SOURCE_ORG,
      partnerId: 'partner-1',
      accessibleOrgIds: [SOURCE_ORG, TARGET_ORG],
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === SOURCE_ORG || id === TARGET_ORG),
      orgCondition: () => undefined,
      token: {},
    });
    return next();
  });
}

// db.select() is used twice in the happy path:
//   1) to load source/target organizations (returns array of org rows)
//   2) to look up the target site (returns array with one site row)
// Each call to .from(...).where(...) returns a thenable resolving to an array.
function rigOrgAndSiteSelects(opts: {
  orgRows: Array<{ id: string; partnerId: string }>;
  siteRow: { id: string } | null;
}) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    if (idx === 0) {
      // organizations lookup uses `.from(organizations).where(...)` (no limit)
      const where = vi.fn().mockResolvedValue(opts.orgRows);
      return { from: vi.fn().mockReturnValue({ where }) } as never;
    }
    // sites lookup uses `.from(sites).where(...).limit(1)`
    const limit = vi.fn().mockResolvedValue(opts.siteRow ? [opts.siteRow] : []);
    const where = vi.fn().mockReturnValue({ limit });
    return { from: vi.fn().mockReturnValue({ where }) } as never;
  });
}

/**
 * Flatten a Drizzle sql`` object into readable text. StringChunks carry a
 * string[] `value`, sql.identifier Names carry a string `value`, nested SQL
 * (subqueries) carries its own queryChunks, and raw bound params are pushed
 * as-is (same chunk shapes as documented in cascadeDelete.test.ts).
 */
function sqlToText(q: any): string {
  const chunks = q?.queryChunks ?? [];
  return chunks
    .map((ch: any) => {
      if (ch !== null && typeof ch === 'object') {
        if (Array.isArray(ch.queryChunks)) return sqlToText(ch);
        if (Array.isArray(ch.value)) return ch.value.join('');
        if ('value' in ch) return String(ch.value);
      }
      return String(ch);
    })
    .join('');
}

function rigTransactionSuccess(updatedRow: any = { ...SAMPLE_DEVICE, orgId: TARGET_ORG, siteId: TARGET_SITE }) {
  // Each tx.execute() call captures the identifier name being UPDATEd (the
  // second chunk in our `UPDATE ${sql.identifier(table)} SET org_id = ...`
  // template — Drizzle exposes it as queryChunks[1].value) plus the full
  // flattened statement text for shape assertions.
  const updatedTables: string[] = [];
  const statements: string[] = [];
  const deviceUpdateSets: any[] = [];

  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          deviceUpdateSets.push(vals);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          };
        }),
      }),
      execute: vi.fn().mockImplementation(async (sqlVal: any) => {
        const tableChunk = sqlVal?.queryChunks?.[1];
        if (tableChunk && typeof tableChunk.value === 'string') {
          updatedTables.push(tableChunk.value);
        }
        statements.push(sqlToText(sqlVal));
        return [];
      }),
    };
    await cb(tx);
    return updatedRow;
  });
  return { updatedTables, statements, deviceUpdateSets };
}

describe('POST /devices/:id/move-org', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = new Hono();
    app.route('/devices', moveOrgRoutes);
  });

  describe('gate registration', () => {
    it('requires partner+system scope, devices:write, organizations:write, and MFA', () => {
      // requireScope called once with (partner, system) — at minimum, those
      // two values must appear in the flattened argument list.
      expect(
        registeredScopeCalls.some((a) => a.includes('partner') && a.includes('system')),
      ).toBe(true);
      expect(registeredPermResources).toContain('devices:write');
      expect(registeredPermResources).toContain('organizations:write');
      expect(registeredMfaCallCount).toBeGreaterThan(0);
    });
  });

  describe('happy path', () => {
    it('moves the device and writes audit on both orgs', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { updatedTables, deviceUpdateSets } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.orgId).toBe(TARGET_ORG);
      expect(body.device.siteId).toBe(TARGET_SITE);

      // devices.set() must include both orgId and siteId flips.
      expect(deviceUpdateSets[0]).toMatchObject({
        orgId: TARGET_ORG,
        siteId: TARGET_SITE,
      });

      // Two audit events, one per org
      expect(writeRouteAudit).toHaveBeenCalledTimes(2);
      const auditOrgIds = vi.mocked(writeRouteAudit).mock.calls.map((c) => (c[1] as any).orgId);
      expect(auditOrgIds).toContain(SOURCE_ORG);
      expect(auditOrgIds).toContain(TARGET_ORG);
      const auditActions = vi.mocked(writeRouteAudit).mock.calls.map((c) => (c[1] as any).action);
      expect(auditActions).toContain('device.move_org.source');
      expect(auditActions).toContain('device.move_org.target');

      // Every denormalized table got an UPDATE issued in the transaction.
      // This is the unit-test proxy for "RLS will read from the new org
      // only post-move": each row in those tables has its org_id rewritten
      // to the new org, so RLS in the OLD org no longer matches it.
      // CUSTOM_ORG_REWRITE_TABLES (ticket_alert_links — no device_id column,
      // rewritten via the alert join) follow the generic org loop. The SITE
      // loop runs last and any table in DEVICE_SITE_DENORMALIZED_TABLES
      // appears in updatedTables a second time for the site_id rewrite.
      expect(updatedTables).toEqual([
        ...DEVICE_ORG_DENORMALIZED_TABLES,
        ...CUSTOM_ORG_REWRITE_TABLES,
        ...DEVICE_SITE_DENORMALIZED_TABLES,
      ]);

      // After the move, the live WS for this agent MUST be closed so the
      // reconnect handshake resolves the new org_id. Otherwise every
      // subsequent runWithAgentDbAccess call writes telemetry under the OLD
      // org's RLS context until natural reconnect (could be hours).
      expect(disconnectAgent).toHaveBeenCalledWith(
        'agent-abc-123',
        expect.any(Number),
        expect.stringContaining('different organization'),
      );
    });

    it('rewrites ticket_alert_links org_id via the alert join inside the transaction', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_alert_links denormalizes org_id for RLS but has NO device_id
      // column, so the generic DEVICE_ORG_DENORMALIZED_TABLES loop can't
      // reach it. Without this dedicated rewrite, links for the moved
      // device's alerts stay under the OLD org's RLS and disappear from the
      // new org's ticket views (tenant-isolation bug).
      const linkRewrites = statements.filter((s) => s.startsWith('UPDATE ticket_alert_links '));
      expect(
        linkRewrites,
        `Expected exactly one ticket_alert_links org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_alert_links SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
    });

    it('writes device.move_org.failed audit when the transaction rolls back', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      // Force the transaction to throw — simulates an FK violation or DB hiccup mid-cascade
      vi.mocked(db.transaction).mockImplementationOnce(async () => {
        throw new Error('simulated DB error mid-cascade');
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });

      expect(res.status).toBe(500);

      // Exactly one failure-audit row on the source org (target never committed)
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as any;
      expect(auditCall?.action).toBe('device.move_org.failed');
      expect(auditCall?.orgId).toBe(SOURCE_ORG);

      // No WS disconnect on failure (device never actually moved)
      expect(disconnectAgent).not.toHaveBeenCalled();
    });
  });

  describe('rejection paths', () => {
    it('returns 404 when the device is not found', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(404);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('returns 403 when caller cannot access the target org', async () => {
      setAuth({ canAccessOrg: (id: string) => id === SOURCE_ORG });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 on a cross-partner move from a partner-scoped caller', async () => {
      setAuth({
        scope: 'partner',
        canAccessOrg: (id: string) => id === SOURCE_ORG || id === OTHER_PARTNER_TARGET_ORG,
      });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: OTHER_PARTNER_TARGET_ORG, partnerId: 'partner-OTHER' },
        ],
        siteRow: { id: TARGET_SITE },
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('allows a cross-partner move when the caller has system scope', async () => {
      setAuth({ scope: 'system', canAccessOrg: () => true });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: OTHER_PARTNER_TARGET_ORG, partnerId: 'partner-OTHER' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      rigTransactionSuccess({ ...SAMPLE_DEVICE, orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 when the target site does not belong to the target org', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: null,
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 400 when the target org equals the source org', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: SOURCE_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed UUIDs in the body', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: 'not-a-uuid', siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
    });
  });
});
