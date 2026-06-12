import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  patches: { id: 'patches.id' },
  patchApprovals: {
    orgId: 'patchApprovals.orgId',
    ringId: 'patchApprovals.ringId',
    patchId: 'patchApprovals.patchId',
    status: 'patchApprovals.status',
    createdAt: 'patchApprovals.createdAt',
  },
}));

// Mirror prod gate semantics:
// - requireScope: tier gate (always passes in these tests)
// - requirePermission: RBAC gate — returns 403 when the caller lacks the perm
// - requireMfa: MFA gate — passes here; we exercise the RBAC gap specifically
let hasPermission = true;
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!hasPermission) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  resolvePatchApprovalOrgId: vi.fn(() => ({ orgId: ORG_ID })),
  upsertPatchApproval: vi.fn(async () => undefined),
}));

import { approvalsRoutes } from './approvals';
import { db } from '../../db';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PATCH_ID = '22222222-2222-4222-8222-222222222222';

function mountApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: (column: unknown) => ({ orgCondition: column, orgId: ORG_ID }),
    });
    await next();
  });
  app.route('/patches', approvalsRoutes);
  return app;
}

function mockPatchLookup(found = true) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(found ? [{ id: PATCH_ID }] : []),
      }),
    }),
  } as never);
}

describe('patch approvals RBAC gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPermission = true;
  });

  describe('without the devices:execute permission', () => {
    beforeEach(() => {
      hasPermission = false;
    });

    it('rejects POST /patches/bulk-approve with 403', async () => {
      const res = await mountApp().request('/patches/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ patchIds: [PATCH_ID] }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects POST /patches/:id/approve with 403', async () => {
      const res = await mountApp().request(`/patches/${PATCH_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it('rejects POST /patches/:id/decline with 403', async () => {
      const res = await mountApp().request(`/patches/${PATCH_ID}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it('rejects POST /patches/:id/defer with 403', async () => {
      const res = await mountApp().request(`/patches/${PATCH_ID}/defer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ deferUntil: '2030-01-01T00:00:00.000Z' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('with the devices:execute permission', () => {
    it('allows POST /patches/bulk-approve', async () => {
      const res = await mountApp().request('/patches/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ patchIds: [PATCH_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.approved).toContain(PATCH_ID);
    });

    it('allows POST /patches/:id/approve', async () => {
      mockPatchLookup(true);
      const res = await mountApp().request(`/patches/${PATCH_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('approved');
    });
  });
});
