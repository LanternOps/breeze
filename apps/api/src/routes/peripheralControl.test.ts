import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  }
}));

vi.mock('../db/schema', () => ({
  peripheralDeviceClassEnum: { enumValues: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'] },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override'] },
  peripheralPolicyActionEnum: { enumValues: ['allow', 'block', 'read_only', 'alert'] },
  peripheralPolicyTargetTypeEnum: { enumValues: ['organization', 'site', 'group', 'device'] },
  peripheralEvents: {
    id: 'id',
    orgId: 'orgId',
    deviceId: 'deviceId',
    policyId: 'policyId',
    eventType: 'eventType',
    peripheralType: 'peripheralType',
    vendor: 'vendor',
    product: 'product',
    serialNumber: 'serialNumber',
    occurredAt: 'occurredAt',
    createdAt: 'createdAt',
  },
  peripheralPolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    deviceClass: 'deviceClass',
    action: 'action',
    targetType: 'targetType',
    isActive: 'isActive',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  })
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDistribution: vi.fn()
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' }
  }
}));

import { peripheralControlRoutes } from './peripheralControl';

describe('peripheralControl routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    app = new Hono();
    app.route('/peripherals', peripheralControlRoutes);
  });

  it('rejects activity windows larger than 90 days', async () => {
    const res = await app.request(
      '/peripherals/activity?start=2026-01-01T00:00:00.000Z&end=2026-05-01T00:00:00.000Z',
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('cannot exceed 90 days');
  });

  it('rejects policy mutation when permission gate fails', async () => {
    permissionGate.deny = true;

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(403);
  });

  it('rejects policy mutation when MFA gate fails', async () => {
    mfaGate.deny = true;

    const res = await app.request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Block storage',
        deviceClass: 'storage',
        action: 'block',
        targetType: 'organization'
      })
    });

    expect(res.status).toBe(403);
  });
});
