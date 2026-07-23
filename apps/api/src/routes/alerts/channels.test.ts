import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Unit tests for partner-wide gating (#2130) on
// apps/api/src/routes/alerts/channels.ts. getNotificationChannelWithOrgCheck
// (./helpers) is dual-axis and deliberately left UNMOCKED so a partner-scope
// caller on the matching partner can LOAD a partner-wide row (orgId NULL,
// partnerId set) via the real logic; the 403 on PUT/DELETE comes from the
// canManagePartnerWidePolicies gate in the route itself, not from the lookup.
// partnerWideAccess.ts is a dependency-free leaf and intentionally NOT mocked
// (per CLAUDE.md / the repo's app-layer-gate testing convention).

const { authRef, insertedRef, existingRowRef, updateSetRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Org User', email: 'user@org.example' },
      partnerId: null as string | null,
      partnerOrgAccess: undefined as 'all' | 'selected' | 'none' | undefined,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  existingRowRef: { current: undefined as Record<string, unknown> | undefined },
  updateSetRef: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  // RBAC (ALERTS_WRITE) is covered elsewhere; always granted here so the
  // partner-wide capability gate is what's under test.
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  // Referenced (unused) by ./helpers' import of siteAccessCheck; not invoked
  // by any path these tests exercise.
  siteAccessCheck: () => () => true,
  // The test route is self-managed (#1105 / BREEZE-A) and builds its own DB
  // context from auth via dbAccessContextFromAuth; stub it to pass the auth
  // straight through to the (also-stubbed) withDbAccessContext.
  dbAccessContextFromAuth: (auth: any) => auth,
}));

// Minimal insert/update/select builder — shared across insert/update/select
// because the route issues at most one lookup followed by at most one
// mutation per request (mirrors the routing.writes.test.ts convention).
vi.mock('../../db', () => {
  const builder: any = {
    values: (vals: Record<string, unknown>) => {
      insertedRef.current = vals;
      return builder;
    },
    set: (vals: Record<string, unknown>) => {
      updateSetRef.current = vals;
      return builder;
    },
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(existingRowRef.current ? [existingRowRef.current] : []),
    returning: () => {
      if (insertedRef.current) {
        return Promise.resolve([{
          id: 'new-channel',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-01T00:00:00Z'),
          lastTestedAt: null,
          lastTestStatus: null,
          throttleMaxPerWindow: null,
          throttleWindowSeconds: 3600,
          ...insertedRef.current,
        }]);
      }
      return Promise.resolve([{ ...(existingRowRef.current ?? {}), ...(updateSetRef.current ?? {}) }]);
    },
  };
  return {
    db: {
      insert: () => builder,
      update: () => builder,
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      select: () => builder,
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

vi.mock('../../db/schema', () => ({
  notificationChannels: {
    id: { name: 'id' },
    orgId: { name: 'org_id' },
    partnerId: { name: 'partner_id' },
    type: { name: 'type' },
    name: { name: 'name' },
    enabled: { name: 'enabled' },
    config: { name: 'config' },
    updatedAt: { name: 'updated_at' },
    createdAt: { name: 'created_at' },
  },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  partners: { id: { name: 'id' }, settings: { name: 'settings' } },
  // Referenced (unused) by ./helpers' unrelated exports; not exercised here.
  alertRules: {},
  alertTemplates: {},
  alerts: {},
  devices: {},
  escalationPolicies: {},
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

// Bypass real crypto — these tests exercise partner-wide gating, not the
// secrets pipeline (already covered by aiToolsAlerts.channelSecrets.test.ts
// and the notificationChannelSecrets suite).
vi.mock('../../services/notificationChannelSecrets', () => ({
  encryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
  decryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
  redactNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
}));

import { channelsRoutes } from './channels';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', channelsRoutes);
  return app;
}

const CHANNEL_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const PARTNER_ID = '99999999-9999-4999-8999-999999999999';

function setPartnerAuth(partnerOrgAccess: 'all' | 'selected' | 'none') {
  authRef.current = {
    scope: 'partner',
    user: { id: 'u-1', name: 'Partner Admin', email: 'admin@msp.example' },
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
  } as typeof authRef.current;
}

const PARTNER_WIDE_CHANNEL = {
  id: CHANNEL_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  name: 'Fleet Webhook',
  type: 'webhook',
  config: { url: 'https://hooks.example.com/x', method: 'POST' },
  enabled: true,
  throttleMaxPerWindow: null,
  throttleWindowSeconds: 3600,
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('notification channels — partner-wide gating (#2130)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRef.current = undefined;
    existingRowRef.current = undefined;
    updateSetRef.current = undefined;
  });

  describe('PUT /alerts/channels/:id', () => {
    it('403s a partner-wide channel without the partner-wide capability (orgAccess selected)', async () => {
      setPartnerAuth('selected');
      existingRowRef.current = { ...PARTNER_WIDE_CHANNEL };

      const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked' }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(updateSetRef.current).toBeUndefined();
    });

    it('allows updating a partner-wide channel with full partner org access (orgAccess all)', async () => {
      setPartnerAuth('all');
      existingRowRef.current = { ...PARTNER_WIDE_CHANNEL };

      const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Fleet Webhook' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe('Renamed Fleet Webhook');
      expect(updateSetRef.current?.name).toBe('Renamed Fleet Webhook');
    });
  });

  describe('DELETE /alerts/channels/:id', () => {
    it('403s a partner-wide channel without the partner-wide capability (orgAccess none)', async () => {
      setPartnerAuth('none');
      existingRowRef.current = { ...PARTNER_WIDE_CHANNEL };

      const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    });

    it('allows deleting a partner-wide channel with full partner org access (orgAccess all)', async () => {
      setPartnerAuth('all');
      existingRowRef.current = { ...PARTNER_WIDE_CHANNEL };

      const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  describe('POST /alerts/channels/:id/test', () => {
    it('403s a partner-wide channel without the partner-wide capability — test-send fires REAL external notifications', async () => {
      setPartnerAuth('selected');
      existingRowRef.current = { ...PARTNER_WIDE_CHANNEL };

      const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    });
  });

  describe('POST /alerts/channels (ownerScope: partner)', () => {
    const partnerWideBody = {
      ownerScope: 'partner',
      name: 'Fleet Webhook',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST' },
      enabled: true,
    };

    it('403s without the partner-wide capability (orgAccess selected)', async () => {
      setPartnerAuth('selected');

      const res = await makeApp().request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partnerWideBody),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(insertedRef.current).toBeUndefined();
    });

    it('201s with full partner org access and inserts { orgId: null, partnerId } (orgAccess all)', async () => {
      setPartnerAuth('all');

      const res = await makeApp().request('/alerts/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partnerWideBody),
      });

      expect(res.status).toBe(201);
      expect(insertedRef.current?.orgId).toBeNull();
      expect(insertedRef.current?.partnerId).toBe(PARTNER_ID);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe('Fleet Webhook');
    });
  });
});
