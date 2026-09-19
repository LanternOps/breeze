import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  peripheralDeviceClassEnum: { enumValues: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'] },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override'] },
  peripheralPolicyActionEnum: { enumValues: ['allow', 'block', 'read_only', 'alert'] },
  peripheralPolicyTargetTypeEnum: { enumValues: ['organization', 'site', 'group', 'device'] },
  peripheralEvents: { id: 'id', orgId: 'orgId', deviceId: 'deviceId', policyId: 'policyId', eventType: 'eventType', peripheralType: 'peripheralType', vendor: 'vendor', product: 'product', serialNumber: 'serialNumber', occurredAt: 'occurredAt', createdAt: 'createdAt' },
  peripheralPolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', name: 'name', deviceClass: 'deviceClass', action: 'action', targetType: 'targetType', priority: 'priority', isActive: 'isActive', updatedAt: 'updatedAt' },
  devices: { id: 'id', orgId: 'orgId', siteId: 'siteId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
  canAccessSite: () => true,
}));

import { peripheralControlRoutes } from './peripheralControl';
import { db } from '../db';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => undefined,
    user: { id: 'user-123', email: 'test@example.com' },
  };
}

function app() {
  const instance = new Hono();
  instance.route('/peripherals', peripheralControlRoutes);
  return instance;
}

describe('peripheral policy routes site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /peripherals/policies (create) denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds);
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization',
      }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/policies with id (update) denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: POLICY_ID, name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization',
      }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/policies/:id/disable denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/peripherals/policies/${POLICY_ID}/disable`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/exceptions denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request('/peripherals/exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyId: POLICY_ID, operation: 'add', exception: { vendor: '0x1234' } }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: create proceeds to insert', async () => {
    authRef.current = orgAuth(undefined);
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization' }])),
      })),
    });
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization' }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
