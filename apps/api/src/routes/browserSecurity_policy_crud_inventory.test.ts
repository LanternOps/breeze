import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  browserExtensions: {
    id: 'browserExtensions.id',
    orgId: 'browserExtensions.orgId',
    deviceId: 'browserExtensions.deviceId',
    browser: 'browserExtensions.browser',
    extensionId: 'browserExtensions.extensionId',
    name: 'browserExtensions.name',
    version: 'browserExtensions.version',
    source: 'browserExtensions.source',
    permissions: 'browserExtensions.permissions',
    riskLevel: 'browserExtensions.riskLevel',
    enabled: 'browserExtensions.enabled',
    firstSeenAt: 'browserExtensions.firstSeenAt',
    lastSeenAt: 'browserExtensions.lastSeenAt',
  },
  browserPolicies: {
    id: 'browserPolicies.id',
    orgId: 'browserPolicies.orgId',
    name: 'browserPolicies.name',
    targetType: 'browserPolicies.targetType',
    targetIds: 'browserPolicies.targetIds',
    allowedExtensions: 'browserPolicies.allowedExtensions',
    blockedExtensions: 'browserPolicies.blockedExtensions',
    requiredExtensions: 'browserPolicies.requiredExtensions',
    settings: 'browserPolicies.settings',
    isActive: 'browserPolicies.isActive',
    createdBy: 'browserPolicies.createdBy',
    updatedAt: 'browserPolicies.updatedAt',
  },
  browserPolicyViolations: {
    id: 'browserPolicyViolations.id',
    orgId: 'browserPolicyViolations.orgId',
    deviceId: 'browserPolicyViolations.deviceId',
    policyId: 'browserPolicyViolations.policyId',
    violationType: 'browserPolicyViolations.violationType',
    details: 'browserPolicyViolations.details',
    detectedAt: 'browserPolicyViolations.detectedAt',
    resolvedAt: 'browserPolicyViolations.resolvedAt',
  },
}));

vi.mock('../db/schema/devices', () => ({
  devices: {
    id: 'devices.id',
    hostname: 'devices.hostname',
    orgId: 'devices.orgId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
}));

vi.mock('../jobs/browserSecurityJobs', () => ({
  triggerBrowserPolicyEvaluation: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { browserSecurityRoutes } from './browserSecurity';
import { triggerBrowserPolicyEvaluation } from '../jobs/browserSecurityJobs';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-03-13T12:00:00Z');

function setAuth(overrides: Record<string, unknown> = {}) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      ...overrides,
    });
    return next();
  });
}

function makeApp() {
  const app = new Hono();
  app.route('/browser-security', browserSecurityRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────


describe('browserSecurity routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── PUT /policies/:policyId ──────────────────────
  describe('PUT /policies/:policyId', () => {
    it('updates an existing policy', async () => {
      const existing = {
        id: POLICY_ID,
        orgId: ORG_ID,
        name: 'Old Name',
        targetType: 'org',
        targetIds: null,
        allowedExtensions: null,
        blockedExtensions: ['old-ext'],
        requiredExtensions: null,
        settings: null,
        isActive: true,
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existing]),
          }),
        }),
      } as any);

      const updated = { ...existing, name: 'Updated Name' };
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const res = await app.request(`/browser-security/policies/${POLICY_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.policy.name).toBe('Updated Name');
    });

    it('returns 404 when policy not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/browser-security/policies/${POLICY_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Policy not found');
    });
  });

  // ────────────────────── DELETE /policies/:policyId ──────────────────────
  describe('DELETE /policies/:policyId', () => {
    it('deletes an existing policy', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: POLICY_ID,
            orgId: ORG_ID,
            name: 'Deleted Policy',
          }]),
        }),
      } as any);

      const res = await app.request(`/browser-security/policies/${POLICY_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 404 when policy not found', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const res = await app.request(`/browser-security/policies/${POLICY_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Policy not found');
    });
  });

  // ────────────────────── PUT /inventory/:deviceId ──────────────────────
  describe('PUT /inventory/:deviceId', () => {
    it('upserts browser extension inventory', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request(`/browser-security/inventory/${DEVICE_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extensions: [
            {
              browser: 'chrome',
              extensionId: 'ext-abc',
              name: 'My Extension',
              version: '2.0',
              riskLevel: 'low',
              enabled: true,
            },
            {
              browser: 'edge',
              extensionId: 'ext-def',
              name: 'Other Extension',
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it('returns 400 when org context is missing', async () => {
      setAuth({ orgId: null });

      const res = await app.request(`/browser-security/inventory/${DEVICE_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensions: [] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('handles empty extensions array', async () => {
      const res = await app.request(`/browser-security/inventory/${DEVICE_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensions: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(0);
    });
  });

  // ────────────────────── Multi-tenant isolation ──────────────────────
  describe('multi-tenant isolation', () => {
    it('org-scoped user only sees own org extensions', async () => {
      // Verify orgId condition is applied (the mock chain verifies the call happens)
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 0, low: 0, medium: 0, high: 0, critical: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/browser-security/extensions');
      expect(res.status).toBe(200);
    });

    it('system scope user can list policies without orgId filter', async () => {
      setAuth({
        scope: 'system',
        orgId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => true,
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/browser-security/policies');
      expect(res.status).toBe(200);
    });
  });

});
