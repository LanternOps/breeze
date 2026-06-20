import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Site-axis enforcement on networkChange by-id and bulk paths (T9, #1051):
// GET /:id, POST /:id/acknowledge, POST /:id/link-device, POST /bulk-acknowledge.
// Site scope is app-layer-only (RLS does NOT enforce it). GET / narrows by
// allowedSiteIds, but the by-id/bulk handlers historically did not, so a
// site-restricted org user could read/act on events in other sites of the same
// org. Out-of-site → 404 (single) / dropped from the mutated set (bulk).

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_A = 'c1c1c1c1-cccc-4ccc-8ccc-cccccccccccc'; // SITE_A
const EVENT_B = 'c2c2c2c2-cccc-4ccc-8ccc-cccccccccccc'; // SITE_B
const DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  networkChangeEvents: {
    id: 'id', orgId: 'org_id', siteId: 'site_id', baselineId: 'baseline_id',
    profileId: 'profile_id', eventType: 'event_type', ipAddress: 'ip_address',
    macAddress: 'mac_address', hostname: 'hostname', acknowledged: 'acknowledged',
    acknowledgedBy: 'acknowledged_by', acknowledgedAt: 'acknowledged_at', notes: 'notes',
    alertId: 'alert_id', linkedDeviceId: 'linked_device_id', detectedAt: 'detected_at',
    createdAt: 'created_at',
  },
  networkBaselines: { id: 'id', subnet: 'subnet' },
  sites: { id: 'id', orgId: 'org_id' },
  devices: { id: 'id', orgId: 'org_id' },
  alerts: { id: 'id', deviceId: 'device_id' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization', orgId: ORG_ID, partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    // Mirror prod: requirePermission populates `permissions`.
    const restrict = c.req.header('x-restrict-site');
    c.set('permissions', restrict ? {
      permissions: [{ resource: 'devices', action: 'read' }],
      partnerId: null, orgId: ORG_ID, roleId: 'role-1', scope: 'organization',
      allowedSiteIds: restrict === '__empty__' ? [] : [restrict],
    } : undefined);
    return next();
  }),
}));

import { db } from '../db';
import { networkChangeRoutes } from './networkChanges';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_A, orgId: ORG_ID, siteId: SITE_A, baselineId: null, profileId: null,
    eventType: 'new_device', ipAddress: '192.168.1.50', macAddress: 'aa:bb:cc:dd:ee:ff',
    hostname: 'new-host', vendor: null, deviceData: null, previousData: null,
    acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, notes: null,
    alertId: null, linkedDeviceId: null,
    detectedAt: new Date('2026-03-01T12:00:00Z'), createdAt: new Date('2026-03-01T12:00:00Z'),
    ...overrides,
  };
}

// db.select chain that resolves the same payload regardless of terminator
function selectResolving(rows: any[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (v: any) => void, reject?: (r: any) => void) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe('networkChange by-id/bulk site-axis scope (T9, #1051)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    app = new Hono();
    app.route('/changes', networkChangeRoutes);
  });

  // ---- GET /:id ----
  describe('GET /changes/:id', () => {
    it('404 on an out-of-site event for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_B, siteId: SITE_B })]) as any);
      const res = await app.request(`/changes/${EVENT_B}`, { headers: { 'x-restrict-site': SITE_A } });
      expect(res.status).toBe(404);
    });

    it('200 on an in-site event for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_A, siteId: SITE_A })]) as any)
        .mockReturnValueOnce(selectResolving([]) as any); // baseline lookup
      const res = await app.request(`/changes/${EVENT_A}`, { headers: { 'x-restrict-site': SITE_A } });
      expect(res.status).toBe(200);
    });

    it('200 on an out-of-site event for an unrestricted caller (no regression)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_B, siteId: SITE_B })]) as any)
        .mockReturnValueOnce(selectResolving([]) as any);
      const res = await app.request(`/changes/${EVENT_B}`);
      expect(res.status).toBe(200);
    });
  });

  // ---- POST /:id/acknowledge ----
  describe('POST /changes/:id/acknowledge', () => {
    it('404 and no write on an out-of-site event for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_B, siteId: SITE_B })]) as any);
      const res = await app.request(`/changes/${EVENT_B}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('acknowledges an in-site event for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_A, siteId: SITE_A })]) as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeEvent({ id: EVENT_A, siteId: SITE_A, acknowledged: true })]),
          }),
        }),
      } as any);
      const res = await app.request(`/changes/${EVENT_A}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  // ---- POST /:id/link-device ----
  describe('POST /changes/:id/link-device', () => {
    it('404 and no write on an out-of-site event for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([makeEvent({ id: EVENT_B, siteId: SITE_B })]) as any);
      const res = await app.request(`/changes/${EVENT_B}/link-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ---- POST /bulk-acknowledge ----
  describe('POST /changes/bulk-acknowledge', () => {
    it('drops out-of-site events from the mutated set for a SITE_A-restricted caller', async () => {
      // accessibleEvents lookup returns both; site filter must keep only EVENT_A
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([
        { id: EVENT_A, orgId: ORG_ID, siteId: SITE_A },
        { id: EVENT_B, orgId: ORG_ID, siteId: SITE_B },
      ]) as any);

      const whereSpy = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: EVENT_A, orgId: ORG_ID }]),
      });
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: whereSpy }),
      } as any);

      const res = await app.request('/changes/bulk-acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({ eventIds: [EVENT_A, EVENT_B] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.acknowledgedCount).toBe(1);
      expect(body.requestedCount).toBe(2);
      expect(body.inaccessibleCount).toBe(1);
    });

    it('404 (no write) when every event is out-of-site for a SITE_A-restricted caller', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([
        { id: EVENT_B, orgId: ORG_ID, siteId: SITE_B },
      ]) as any);

      const res = await app.request('/changes/bulk-acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-restrict-site': SITE_A },
        body: JSON.stringify({ eventIds: [EVENT_B] }),
      });

      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('acknowledges all events for an unrestricted caller (no regression)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResolving([
        { id: EVENT_A, orgId: ORG_ID, siteId: SITE_A },
        { id: EVENT_B, orgId: ORG_ID, siteId: SITE_B },
      ]) as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: EVENT_A, orgId: ORG_ID }, { id: EVENT_B, orgId: ORG_ID },
            ]),
          }),
        }),
      } as any);

      const res = await app.request('/changes/bulk-acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds: [EVENT_A, EVENT_B] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.acknowledgedCount).toBe(2);
      expect(body.inaccessibleCount).toBe(0);
    });
  });
});
