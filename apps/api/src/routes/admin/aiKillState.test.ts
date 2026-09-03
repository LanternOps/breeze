/**
 * Wave 6 PR 2 (#3828), Task 4 — the AI kill switch's FIRST authorized write
 * surface. `bumpAiKillState` shipped in wave 5A with "called by nobody yet
 * (Part B or an ops runbook)" — this route is that caller. These tests pin
 * the posture: platform-admin for both verbs, MFA on the flip, a mandatory
 * reason, and an audit row on every successful flip.
 *
 * The platform-admin UI (apps/web AiKillSwitch.tsx, #4208) is a thin client of
 * this route — these tests remain the authoritative contract for the
 * authorization/validation/audit posture. Runbook: docs/deploy/ai-kill-switch.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readRowMock, bumpMock } = vi.hoisted(() => ({
  readRowMock: vi.fn(),
  bumpMock: vi.fn(),
}));

vi.mock('../../services/aiKillState', () => ({
  readAiKillStateRow: readRowMock,
  bumpAiKillState: bumpMock,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

// authMiddleware is stubbed to mirror real behavior: 401 when the request
// carries no auth context, pass-through otherwise. requireMfa keeps the real
// 401/403 split.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { createAuditLogAsync } from '../../services/auditService';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const platformAdminNoMfa: FakeAuth = { ...platformAdmin, token: { mfa: false } };
const partnerAdmin: FakeAuth = {
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const ROW = {
  killed: false,
  epoch: 4,
  reason: 'restored after incident 123',
  updatedBy: 'admin-0',
  updatedAt: new Date('2026-08-28T12:00:00Z'),
};

function post(app: Hono, body: unknown) {
  return app.request('/admin/ai-kill-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('admin AI kill-state routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readRowMock.mockResolvedValue(ROW);
    bumpMock.mockResolvedValue({ killed: true, epoch: 5 });
  });

  describe('authorization', () => {
    it('401s an unauthenticated GET', async () => {
      const res = await buildApp(null).request('/admin/ai-kill-state');
      expect(res.status).toBe(401);
      expect(readRowMock).not.toHaveBeenCalled();
    });

    it('403s a non-platform-admin GET at platformAdminMiddleware', async () => {
      const res = await buildApp(partnerAdmin).request('/admin/ai-kill-state');
      expect(res.status).toBe(403);
      expect(readRowMock).not.toHaveBeenCalled();
    });

    it('403s a non-platform-admin POST', async () => {
      const res = await post(buildApp(partnerAdmin), { killed: true, reason: 'incident' });
      expect(res.status).toBe(403);
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('403s a POST from a platform admin who has not satisfied MFA', async () => {
      const res = await post(buildApp(platformAdminNoMfa), { killed: true, reason: 'incident' });
      expect(res.status).toBe(403);
      expect((await res.json() as any).code).toBe('MFA_REQUIRED');
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('does NOT require MFA to read', async () => {
      const res = await buildApp(platformAdminNoMfa).request('/admin/ai-kill-state');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /admin/ai-kill-state', () => {
    it('returns the fresh (uncached) row — killed, epoch, reason, provenance', async () => {
      const res = await buildApp(platformAdmin).request('/admin/ai-kill-state');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          killed: false,
          epoch: 4,
          reason: 'restored after incident 123',
          updatedBy: 'admin-0',
          updatedAt: '2026-08-28T12:00:00.000Z',
        },
      });
      expect(readRowMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /admin/ai-kill-state', () => {
    it('400s when reason is missing', async () => {
      const res = await post(buildApp(platformAdmin), { killed: true });
      expect(res.status).toBe(400);
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('400s a reason shorter than 3 characters', async () => {
      const res = await post(buildApp(platformAdmin), { killed: true, reason: 'ab' });
      expect(res.status).toBe(400);
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('400s a non-boolean killed', async () => {
      const res = await post(buildApp(platformAdmin), { killed: 'yes', reason: 'incident 123' });
      expect(res.status).toBe(400);
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('400s unknown extra fields (strict body — no smuggled columns)', async () => {
      const res = await post(buildApp(platformAdmin), {
        killed: true, reason: 'incident 123', epoch: 99,
      });
      expect(res.status).toBe(400);
      expect(bumpMock).not.toHaveBeenCalled();
    });

    it('flips the switch on: bumps with the caller identity and audits', async () => {
      const res = await post(buildApp(platformAdmin), { killed: true, reason: 'incident 123' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { killed: true, epoch: 5 } });

      expect(bumpMock).toHaveBeenCalledTimes(1);
      expect(bumpMock).toHaveBeenCalledWith(true, 'incident 123', 'admin-1');

      // createAuditLogAsync deliberately: the flip is already committed, so
      // an audit-write failure must never 500 the response (retry queue +
      // Sentry cover the trail). platformAdminMiddleware writes its own
      // `platform_admin.*` row through the same fn — filter to the flip's.
      const flipAudits = vi.mocked(createAuditLogAsync).mock.calls
        .filter((call) => call[0]!.action === 'ai_kill_state.updated');
      expect(flipAudits).toHaveLength(1);
      const audit = flipAudits[0]![0]!;
      expect(audit).toMatchObject({
        orgId: null,
        actorType: 'user',
        actorId: 'admin-1',
        action: 'ai_kill_state.updated',
        resourceType: 'ai_kill_state',
        resourceId: 'global',
        result: 'success',
      });
      expect(audit.details).toMatchObject({ killed: true, reason: 'incident 123', epoch: 5 });
    });

    it('flips the switch back off through the same surface', async () => {
      bumpMock.mockResolvedValue({ killed: false, epoch: 6 });
      const res = await post(buildApp(platformAdmin), { killed: false, reason: 'incident resolved' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { killed: false, epoch: 6 } });
      expect(bumpMock).toHaveBeenCalledWith(false, 'incident resolved', 'admin-1');
    });

    it('does not write a flip audit when the bump itself fails', async () => {
      bumpMock.mockRejectedValue(new Error("seed row (id='global') is missing"));
      const res = await post(buildApp(platformAdmin), { killed: true, reason: 'incident 123' });
      expect(res.status).toBe(500);
      // platformAdminMiddleware still audits the request itself; only the
      // route's ai_kill_state.updated row must be absent.
      const flipAudits = vi.mocked(createAuditLogAsync).mock.calls
        .filter((call) => call[0]!.action === 'ai_kill_state.updated');
      expect(flipAudits).toHaveLength(0);
    });
  });
});
