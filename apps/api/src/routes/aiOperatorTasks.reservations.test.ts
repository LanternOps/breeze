/**
 * `POST /ai/operator/tasks/:id/account-reservations/release` (#9981): a person
 * who checked the provider releases the accounts a terminal task still holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  findVisibleTask: vi.fn(),
  release: vi.fn(),
  audit: vi.fn(),
  permissions: [] as Array<{ resource: string; action: string }>,
  deniedGates: [] as string[],
  mfaRequired: false,
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    authMiddleware: pass, requireScope: () => pass,
    requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) => {
      if (h.deniedGates.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
      return next();
    },
    requireMfa: () => async (c: any, next: () => Promise<void>) => (h.mfaRequired ? c.json({ error: 'MFA required' }, 403) : next()),
    buildOrgAccessClosures: actual.buildOrgAccessClosures,
  };
});
vi.mock('../services/aiOperator/taskReadQueries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findVisibleTask: (...a: unknown[]) => h.findVisibleTask(...a),
}));
vi.mock('../services/aiOperator/accountReservations', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  releaseTaskAccountReservations: (...a: unknown[]) => h.release(...a),
}));
vi.mock('../services/auditEvents', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeRouteAudit: (...a: unknown[]) => h.audit(...a),
}));
vi.mock('../db', () => ({ db: {} }));

import { aiOperatorTasksRoutes } from './aiOperatorTasks';

const ORG = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

function app(authOverrides: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: ORG, partnerId: null, accessibleOrgIds: [ORG],
      user: { id: 'user-1', email: 't@example.com', name: 'Tech' },
      canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined,
      allowedSiteIds: undefined, canAccessSite: () => true, ...authOverrides,
    } as never);
    c.set('permissions', { permissions: h.permissions } as never);
    await next();
  });
  a.route('/ai/operator', aiOperatorTasksRoutes);
  return a;
}

const release = (body: unknown = {}, a = app(), id = TASK) => a.request(`/ai/operator/tasks/${id}/account-reservations/release`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.deniedGates = [];
  h.mfaRequired = false;
  h.permissions = [{ resource: 'organizations', action: 'write' }];
  h.findVisibleTask.mockResolvedValue({ id: TASK, orgId: ORG, state: 'handed_off' });
  h.release.mockResolvedValue({ ok: true, released: 2 });
});

describe('POST /tasks/:id/account-reservations/release', () => {
  it('releases a terminal task\'s accounts, records who did it and the note, and audits', async () => {
    const res = await release({ note: 'checked Entra: account disabled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: 2 });
    expect(h.release).toHaveBeenCalledWith({ orgId: ORG, taskId: TASK, userId: 'user-1', note: 'checked Entra: account disabled' });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'ai_operator.account_reservations.release', resourceType: 'ai_operator_task', resourceId: TASK,
      details: expect.objectContaining({ released: 2 }),
    }));
  });

  it('a live task is 409: stop it instead', async () => {
    h.release.mockResolvedValue({ ok: false, reason: 'task_live', detail: 'task is running' });
    const res = await release();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_TASK_LIVE' });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a task the caller cannot see is a non-enumerating 404, and nothing is released', async () => {
    h.findVisibleTask.mockResolvedValue(null);
    expect((await release()).status).toBe(404);
    expect((await release({}, app(), 'not-a-uuid')).status).toBe(404);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('needs ai_agents:write, organizations:write and an org-wide (not site-restricted) caller', async () => {
    h.deniedGates = ['ai_agents:write'];
    expect((await release()).status).toBe(403);
    h.deniedGates = [];
    h.permissions = [];
    expect((await release()).status).toBe(403);
    h.permissions = [{ resource: 'organizations', action: 'write' }];
    expect((await release({}, app({ allowedSiteIds: ['site-1'] }))).status).toBe(403);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('needs MFA', async () => {
    h.mfaRequired = true;
    expect((await release()).status).toBe(403);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('rejects an unknown body field and an over-long note', async () => {
    expect((await release({ force: true })).status).toBe(400);
    expect((await release({ note: 'x'.repeat(1001) })).status).toBe(400);
    expect(h.release).not.toHaveBeenCalled();
  });
});
