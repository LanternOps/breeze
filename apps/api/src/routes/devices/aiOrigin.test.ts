import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: (orgId: string) => orgId === 'org-123',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', { permissions: [{ resource: 'devices', action: 'read' }] });
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
  canAccessDeviceSite: vi.fn(() => true),
}));

vi.mock('../../services/aiOriginSummary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiOriginSummary')>()),
  resolveAiOriginSummary: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck, canAccessDeviceSite } from './helpers';
import { AiOriginSourceNotFoundError, resolveAiOriginSummary } from '../../services/aiOriginSummary';
import { deviceAiOriginRoutes } from './aiOrigin';

const DEV = 'device-1';

describe('GET /devices/:id/ai-origin (#5022 W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEV, orgId: 'org-123', siteId: null } as never);
    vi.mocked(canAccessDeviceSite).mockReturnValue(true);
    app = new Hono();
    app.route('/devices', deviceAiOriginRoutes);
  });

  const get = (qs: string) =>
    app.request(`/devices/${DEV}/ai-origin${qs}`, { headers: { Authorization: 'Bearer token' } });

  it('returns the authorized summary for a resolvable origin', async () => {
    vi.mocked(resolveAiOriginSummary).mockResolvedValueOnce({
      kind: 'ai_assistant',
      label: 'Support chat',
      occurredAt: '2026-02-08T00:00:00.000Z',
      toolName: null,
      resolvable: true,
      session: { id: 'sess-1' },
    });

    const res = await get('?source=execution&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ kind: 'ai_assistant', resolvable: true, session: { id: 'sess-1' } });
  });

  it('returns data: null for a row with no AI marker', async () => {
    vi.mocked(resolveAiOriginSummary).mockResolvedValueOnce(null);

    const res = await get('?source=execution&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toBeNull();
  });

  it('404s when the source row is not on this device or not visible to the caller', async () => {
    vi.mocked(resolveAiOriginSummary).mockRejectedValueOnce(new AiOriginSourceNotFoundError());

    const res = await get('?source=execution&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(404);
  });

  it('404s when the device itself is not accessible', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(null as never);

    const res = await get('?source=execution&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(404);
    expect(resolveAiOriginSummary).not.toHaveBeenCalled();
  });

  it('403s when the device is outside the caller site restriction', async () => {
    vi.mocked(canAccessDeviceSite).mockReturnValueOnce(false);

    const res = await get('?source=execution&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(403);
    expect(resolveAiOriginSummary).not.toHaveBeenCalled();
  });

  it('rejects an invalid source enum with 400', async () => {
    const res = await get('?source=bogus&sourceId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(400);
  });
});

describe('GET /devices/:id/ai-activity (#5022 W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: DEV, orgId: 'org-123', siteId: null } as never);
    vi.mocked(canAccessDeviceSite).mockReturnValue(true);
    app = new Hono();
    app.route('/devices', deviceAiOriginRoutes);
  });

  function queueCounts(executionCount: number, commandCount: number) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: executionCount }]) }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: commandCount }]) }),
      } as never);
  }

  it('counts one AI script dispatch exactly once, not twice (script_executions row only; its paired device_commands row is type=script and excluded)', async () => {
    queueCounts(1, 0);

    const res = await app.request(`/devices/${DEV}/ai-activity?days=7`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data.dispatchedActions).toBe(1);
  });

  it('counts a direct AI command', async () => {
    queueCounts(0, 1);

    const res = await app.request(`/devices/${DEV}/ai-activity?days=7`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data.dispatchedActions).toBe(1);
  });

  it('excludes unmarked rows entirely (zero from both arms)', async () => {
    queueCounts(0, 0);

    const res = await app.request(`/devices/${DEV}/ai-activity?days=7`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data.dispatchedActions).toBe(0);
  });

  it('caps days at 30', async () => {
    queueCounts(0, 0);

    const res = await app.request(`/devices/${DEV}/ai-activity?days=9999`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data.windowDays).toBe(30);
  });

  it('defaults to 7 days when omitted', async () => {
    queueCounts(0, 0);

    const res = await app.request(`/devices/${DEV}/ai-activity`, { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data.windowDays).toBe(7);
  });
});
