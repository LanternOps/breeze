import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASELINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EVENT_ID_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ALERT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  networkChangeEvents: {
    id: 'id',
    orgId: 'org_id',
    siteId: 'site_id',
    baselineId: 'baseline_id',
    profileId: 'profile_id',
    eventType: 'event_type',
    ipAddress: 'ip_address',
    macAddress: 'mac_address',
    hostname: 'hostname',
    acknowledged: 'acknowledged',
    acknowledgedBy: 'acknowledged_by',
    acknowledgedAt: 'acknowledged_at',
    notes: 'notes',
    alertId: 'alert_id',
    linkedDeviceId: 'linked_device_id',
    detectedAt: 'detected_at',
    createdAt: 'created_at',
  },
  networkBaselines: {
    id: 'id',
    subnet: 'subnet',
  },
  sites: {
    id: 'id',
    orgId: 'org_id',
  },
  devices: {
    id: 'id',
    orgId: 'org_id',
  },
  alerts: {
    id: 'id',
    deviceId: 'device_id',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { networkChangeRoutes } from './networkChanges';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    baselineId: BASELINE_ID,
    profileId: null,
    eventType: 'new_device',
    ipAddress: '192.168.1.50',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    hostname: 'new-host',
    vendor: null,
    deviceData: null,
    previousData: null,
    acknowledged: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
    notes: null,
    alertId: null,
    linkedDeviceId: null,
    detectedAt: new Date('2026-03-01T12:00:00Z'),
    createdAt: new Date('2026-03-01T12:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


describe('networkChange routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset db mock return queues to prevent cross-test contamination
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => null,
      });
      return next();
    });
    app = new Hono();
    app.route('/changes', networkChangeRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List network changes
  // ----------------------------------------------------------------

  describe('GET /changes', () => {
    it('should list change events for the org', async () => {
      const events = [makeEvent()];
      vi.mocked(db.select)
        // count
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        } as any)
        // data
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue(
                      events.map((e) => ({ event: e, baselineSubnet: '192.168.1.0/24' }))
                    ),
                  }),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/changes?orgId=${ORG_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].baselineSubnet).toBe('192.168.1.0/24');
      expect(body.pagination.total).toBe(1);
    });

    it('should filter by eventType', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/changes?orgId=${ORG_ID}&eventType=rogue_device`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });

    it('should filter by acknowledged status', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/changes?orgId=${ORG_ID}&acknowledged=false`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
    });

    it('should reject invalid eventType', async () => {
      const res = await app.request(`/changes?orgId=${ORG_ID}&eventType=bad_type`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid limit', async () => {
      const res = await app.request(`/changes?orgId=${ORG_ID}&limit=999`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('should deny org user accessing different org', async () => {
      const res = await app.request(`/changes?orgId=${ORG_ID_2}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id - Get single change event
  // ----------------------------------------------------------------

  describe('GET /changes/:id', () => {
    it('should return a change event by ID', async () => {
      const event = makeEvent();
      // getChangeEventWithAccess
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([event]),
            }),
          }),
        } as any)
        // baseline lookup
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: BASELINE_ID, subnet: '192.168.1.0/24' }]),
            }),
          }),
        } as any);

      const res = await app.request(`/changes/${EVENT_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(EVENT_ID);
      expect(body.baselineSubnet).toBe('192.168.1.0/24');
    });

    it('should return 404 when event not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/changes/${EVENT_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/acknowledge - Acknowledge a change
  // ----------------------------------------------------------------

  describe('POST /changes/:id/acknowledge', () => {
    it('should acknowledge a change event', async () => {
      const event = makeEvent();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([event]),
          }),
        }),
      } as any);

      const acknowledged = makeEvent({
        acknowledged: true,
        acknowledgedBy: 'user-123',
        acknowledgedAt: new Date(),
      });
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([acknowledged]),
          }),
        }),
      } as any);

      const res = await app.request(`/changes/${EVENT_ID}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ notes: 'Verified safe device' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.acknowledged).toBe(true);
    });

    it('should return 400 when event is already acknowledged', async () => {
      const event = makeEvent({ acknowledged: true });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([event]),
          }),
        }),
      } as any);

      const res = await app.request(`/changes/${EVENT_ID}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('already acknowledged');
    });

    it('should return 404 when event not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/changes/${EVENT_ID}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });

    it('should validate notes max length', async () => {
      // zValidator rejects before getChangeEventWithAccess runs -- no db mock needed
      const res = await app.request(`/changes/${EVENT_ID}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ notes: 'x'.repeat(2001) }),
      });

      expect(res.status).toBe(400);
    });
  });

});
