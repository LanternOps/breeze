import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  patches: { id: 'patches.id' },
  patchApprovals: {
    partnerId: 'patchApprovals.partnerId',
    ringId: 'patchApprovals.ringId',
    patchId: 'patchApprovals.patchId',
    status: 'patchApprovals.status',
    createdAt: 'patchApprovals.createdAt',
  },
}));

// Mirror prod gate semantics:
// - requireScope: tier gate (always passes in these tests)
// - requirePermission: RBAC gate — returns 403 when the caller lacks the perm.
//   The mock grants exactly one permission at a time, so each read/write
//   allow-path catches a route wired to the wrong permission.
// - requireMfa: MFA gate — controllable via mfaSatisfied; default pass-through.
let grantedPermission: 'devices:read' | 'devices:execute' | null = 'devices:execute';
let mfaSatisfied = true;
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const required = `${resource}:${action}`;
    // 403 if the caller lacks the exact grant required by the route.
    if (required !== grantedPermission) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  // Mirror the real requireMfa(), which throws HTTPException(403) when MFA is
  // required. Hono's default error handler renders that as a 403 response.
  requireMfa: vi.fn(() => async (_c: any, next: any) => {
    if (!mfaSatisfied) {
      throw new HTTPException(403, { message: 'MFA required' });
    }
    return next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  resolvePatchApprovalPartnerIdForRing: vi.fn(async () => ({ partnerId: PARTNER_ID })),
  upsertPatchApproval: vi.fn(async () => undefined),
}));

import { approvalsRoutes } from './approvals';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolvePatchApprovalPartnerIdForRing, upsertPatchApproval } from './helpers';

const PATCH_ID = '22222222-2222-4222-8222-222222222222';
let partnerOrgAccess: 'all' | 'selected' | 'none' = 'all';

function mountApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('auth', {
      user: { id: 'user-1' },
      scope: 'partner',
      partnerId: PARTNER_ID,
      partnerOrgAccess,
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
    grantedPermission = 'devices:execute';
    mfaSatisfied = true;
    partnerOrgAccess = 'all';
  });

  describe('without the devices:execute permission', () => {
    beforeEach(() => {
      grantedPermission = null;
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

  describe('GET /patches/approvals partner-wide read authority', () => {
    function mockApprovalList() {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([{ id: 'approval-1' }]),
                }),
              }),
            }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }]),
          }),
        } as never);
    }

    it.each(['selected', 'none'] as const)(
      'rejects partner org access %s before partner resolution or database access',
      async (orgAccess) => {
        partnerOrgAccess = orgAccess;
        grantedPermission = 'devices:read';

        const res = await mountApp().request('/patches/approvals', { method: 'GET' });

        expect(res.status).toBe(403);
        expect(resolvePatchApprovalPartnerIdForRing).not.toHaveBeenCalled();
        expect(db.select).not.toHaveBeenCalled();
      },
    );

    it('rejects a caller without devices:read before database access', async () => {
      grantedPermission = null;

      const res = await mountApp().request('/patches/approvals', { method: 'GET' });

      expect(res.status).toBe(403);
      expect(resolvePatchApprovalPartnerIdForRing).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows a full-partner caller with devices:read', async () => {
      grantedPermission = 'devices:read';
      mockApprovalList();

      const res = await mountApp().request('/patches/approvals', { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [{ id: 'approval-1' }],
        pagination: { page: 1, limit: 50, total: 1 },
      });
    });
  });

  describe('with the devices:execute permission and full partner org access', () => {
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

    it('allows POST /patches/:id/decline', async () => {
      mockPatchLookup(true);
      const res = await mountApp().request(`/patches/${PATCH_ID}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('declined');
    });

    it('allows POST /patches/:id/defer', async () => {
      mockPatchLookup(true);
      const deferUntil = '2030-01-01T00:00:00.000Z';
      const res = await mountApp().request(`/patches/${PATCH_ID}/defer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ deferUntil }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'deferred', deferUntil });
    });
  });

  describe.each(['selected', 'none'] as const)('with partner org access %s', (orgAccess) => {
    beforeEach(() => {
      partnerOrgAccess = orgAccess;
    });

    it.each([
      { path: '/patches/bulk-approve', body: { patchIds: [PATCH_ID] } },
      { path: `/patches/${PATCH_ID}/approve`, body: {} },
      { path: `/patches/${PATCH_ID}/decline`, body: {} },
      { path: `/patches/${PATCH_ID}/defer`, body: { deferUntil: '2030-01-01T00:00:00.000Z' } },
    ])('rejects POST $path before any database write, lookup, or audit', async ({ path, body }) => {
      const res = await mountApp().request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(403);
      expect(resolvePatchApprovalPartnerIdForRing).not.toHaveBeenCalled();
      expect(upsertPatchApproval).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  // Guards the requireMfa() gate: with the RBAC permission granted but MFA
  // unsatisfied, the mutating route must still 403. Drops the requireMfa()
  // line from the route and this test fails.
  describe('with the permission but MFA unsatisfied', () => {
    beforeEach(() => {
      grantedPermission = 'devices:execute';
      mfaSatisfied = false;
    });

    it('rejects POST /patches/bulk-approve with 403', async () => {
      const res = await mountApp().request('/patches/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ patchIds: [PATCH_ID] }),
      });
      expect(res.status).toBe(403);
    });
  });
});
