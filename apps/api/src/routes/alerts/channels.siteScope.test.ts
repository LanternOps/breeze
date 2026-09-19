import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Site-ceiling gate (§2 contract-site-ceiling-gate) on notification channels.
// Mirrors the partner-wide gating test (channels.test.ts / #2130) but exercises
// the ORTHOGONAL organization-scope site-ceiling axis: a caller with a defined
// allowedSiteIds may not create/update/delete/test a channel at all, org-owned
// or partner-wide.

const { authRef, insertedRef, existingRowRef, updateSetRef, deleteWhereMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Org User', email: 'user@org.example' },
      partnerId: null as string | null,
      partnerOrgAccess: undefined as 'all' | 'selected' | 'none' | undefined,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      allowedSiteIds: undefined as string[] | undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  existingRowRef: { current: undefined as Record<string, unknown> | undefined },
  updateSetRef: { current: undefined as Record<string, unknown> | undefined },
  deleteWhereMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
  dbAccessContextFromAuth: (auth: any) => auth,
  withAuthDbAccessContext: (_auth: any, fn: () => Promise<unknown>) => fn(),
}));

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
    where: (cond: unknown) => {
      deleteWhereMock(cond);
      return builder;
    },
    limit: () => Promise.resolve(existingRowRef.current ? [existingRowRef.current] : []),
    returning: () => {
      if (insertedRef.current) {
        return Promise.resolve([{ id: 'new-channel', ...insertedRef.current }]);
      }
      return Promise.resolve([{ ...(existingRowRef.current ?? {}), ...(updateSetRef.current ?? {}) }]);
    },
  };
  return {
    db: {
      insert: vi.fn(() => builder),
      update: vi.fn(() => builder),
      delete: vi.fn(() => ({ where: (cond: unknown) => { deleteWhereMock(cond); return Promise.resolve(undefined); } })),
      select: vi.fn(() => builder),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

vi.mock('../../db/schema', () => ({
  notificationChannels: {
    id: { name: 'id' }, orgId: { name: 'org_id' }, partnerId: { name: 'partner_id' },
    type: { name: 'type' }, name: { name: 'name' }, enabled: { name: 'enabled' },
    config: { name: 'config' }, updatedAt: { name: 'updated_at' }, createdAt: { name: 'created_at' },
  },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  partners: { id: { name: 'id' }, settings: { name: 'settings' } },
  alertRules: {}, alertTemplates: {}, alerts: {}, devices: {}, escalationPolicies: {},
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/notificationChannelSecrets', () => ({
  encryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
  decryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
  redactNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config),
  scrubChannelTestError: vi.fn((_type: string, _config: unknown, message: unknown) =>
    typeof message === 'string' ? message : null
  ),
}));

import { channelsRoutes } from './channels';
import { db } from '../../db';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', channelsRoutes);
  return app;
}

const CHANNEL_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ORG_CHANNEL = {
  id: CHANNEL_ID,
  orgId: 'org-1',
  partnerId: null,
  name: 'Org Slack',
  type: 'slack',
  config: { webhookUrl: 'https://hooks.slack.com/x' },
  enabled: true,
  throttleMaxPerWindow: null,
  throttleWindowSeconds: 3600,
};

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    scope: 'organization',
    user: { id: 'u-1', name: 'Org User', email: 'user@org.example' },
    partnerId: null,
    partnerOrgAccess: undefined,
    orgId: 'org-1',
    accessibleOrgIds: null,
    allowedSiteIds,
    canAccessOrg: () => true,
  };
}

describe('notification channels — site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRef.current = undefined;
    existingRowRef.current = undefined;
    updateSetRef.current = undefined;
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /alerts/channels denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds) as typeof authRef.current;
    const res = await makeApp().request('/alerts/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'c', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' }, enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('restricted caller: PUT /alerts/channels/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']) as typeof authRef.current;
    existingRowRef.current = ORG_CHANNEL;
    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /alerts/channels/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']) as typeof authRef.current;
    existingRowRef.current = ORG_CHANNEL;
    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /alerts/channels/:id/test denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']) as typeof authRef.current;
    existingRowRef.current = ORG_CHANNEL;
    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST creates', async () => {
    authRef.current = orgAuth(undefined) as typeof authRef.current;
    const res = await makeApp().request('/alerts/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'c', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' }, enabled: true }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('partner-scope caller with allowedSiteIds set is NOT affected by this gate', async () => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Admin', email: 'admin@msp.example' },
      partnerId: 'partner-1',
      partnerOrgAccess: 'all',
      orgId: null,
      accessibleOrgIds: ['org-1'],
      allowedSiteIds: ['s1'],
      canAccessOrg: () => true,
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '11111111-1111-4111-8111-111111111111', name: 'c', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' }, enabled: true }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
