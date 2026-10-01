// apps/api/src/routes/admin/aiModels.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const { serviceMocks, enqueueMock, createAuditLogAsyncMock } = vi.hoisted(() => ({
  serviceMocks: {
    listPlatformModels: vi.fn(),
    getPlatformModelById: vi.fn(),
    updatePlatformModelAdmin: vi.fn(),
  },
  enqueueMock: vi.fn(),
  createAuditLogAsyncMock: vi.fn(async () => undefined),
}));

vi.mock('../../services/aiModels/platformModels', () => ({
  ...serviceMocks,
  PlatformModelError: class PlatformModelError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueuePlatformModelSync: enqueueMock }));
vi.mock('../../services/auditService', () => ({ createAuditLog: vi.fn(async () => undefined), createAuditLogAsync: createAuditLogAsyncMock }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1') }));
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
import { PlatformModelError } from '../../services/aiModels/platformModels';

type FakeAuth = { user: { id: string; email: string; name: string; isPlatformAdmin: boolean }; token: { mfa: boolean } };
const admin: FakeAuth = { user: { id: ADMIN_ID, email: 'admin@breeze.test', name: 'Admin', isPlatformAdmin: true }, token: { mfa: true } };
const adminNoMfa: FakeAuth = { ...admin, token: { mfa: false } };
const partnerUser: FakeAuth = { user: { ...admin.user, id: '44444444-4444-4444-8444-444444444444', isPlatformAdmin: false }, token: { mfa: true } };

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const AT = new Date('2026-11-13T00:00:00.000Z');
const MODEL = {
  id: MODEL_ID, provider: 'anthropic', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5',
  maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
  capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }, image_input: { supported: true } },
  rates: RATES, optionRates: null,
  optionSupport: { effort: ['low', 'medium'], thinkingDisplay: ['omitted'], speed: ['standard'], inferenceGeo: [] },
  minPlan: null, promptProfile: 'claude-frontier', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
  missedSyncCount: 0, operatorNotifiedAt: AT, firstSeenAt: AT, lastSeenAt: null, updatedAt: AT,
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

function send(app: Hono, path: string, method: 'POST' | 'PATCH', body?: unknown) {
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.listPlatformModels.mockResolvedValue([MODEL]);
  serviceMocks.updatePlatformModelAdmin.mockResolvedValue({ before: MODEL, after: { ...MODEL, minPlan: 'pro' } });
  enqueueMock.mockResolvedValue({ id: 'ai-model-discovery-sync-platform-manual' });
});

describe('/admin/ai-models', () => {
  it('lists models with derived capabilities and the plan options; never the raw capabilities tree', async () => {
    const res = await buildApp(admin).request('/admin/ai-models');
    expect(res.status).toBe(200);
    const body = await res.json() as { models: Array<Record<string, unknown>>; planOptions: string[] };
    expect(body.models[0]).toMatchObject({
      id: MODEL_ID, modelId: 'claude-opus-5-5', rates: RATES, lifecycle: 'available', lastSeenAt: null,
      derived: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsTools: true, supportsVision: true },
    });
    expect(body.models[0]).not.toHaveProperty('capabilities');
    expect(body.planOptions).toEqual(['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);
  });

  it('403s a non-platform-admin', async () => {
    expect((await buildApp(partnerUser).request('/admin/ai-models')).status).toBe(403);
  });

  it('requires MFA for mutations', async () => {
    const res = await send(buildApp(adminNoMfa), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { minPlan: 'pro' });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('MFA_REQUIRED');
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
  });

  it('PATCH applies a validated patch and audits the decisive values', async () => {
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { minPlan: 'pro' });
    expect(res.status).toBe(200);
    expect(serviceMocks.updatePlatformModelAdmin).toHaveBeenCalledWith(MODEL_ID, { minPlan: 'pro' });
    expect((await res.json() as { model: { minPlan: string } }).model.minPlan).toBe('pro');
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.ai_models.updated',
      resourceType: 'ai_platform_model',
      resourceId: MODEL_ID,
      details: expect.objectContaining({ modelId: 'claude-opus-5-5', changed: ['minPlan'] }),
    }));
  });

  it.each([
    ['an unknown key', { price: 1 }],
    ['an empty body', {}],
    ['a negative rate', { rates: { ...RATES, inputCentsPerM: -1 } }],
    ['a partial rate set', { rates: { inputCentsPerM: 1 } }],
    ['an unknown plan', { minPlan: 'gold' }],
    ['speed without standard', { optionSupport: { effort: [], thinkingDisplay: [], speed: ['fast'], inferenceGeo: [] } }],
  ])('400s %s without calling the service', async (_label, body) => {
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', body);
    expect(res.status).toBe(400);
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
  });

  it('maps a PlatformModelError to its status and message', async () => {
    serviceMocks.updatePlatformModelAdmin.mockRejectedValue(new PlatformModelError('Make another model the default first.', 409));
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { isPlatformDefault: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Make another model the default first.' });
  });

  // Review gap (PR #7643): every mutation, not just PATCH, is behind the
  // platform-admin gate and MFA, and none reaches the service when refused.
  const MUTATIONS = [
    ['PATCH /:id', `/admin/ai-models/${MODEL_ID}`, 'PATCH', { minPlan: 'pro' }],
    ['POST /refresh', '/admin/ai-models/refresh', 'POST', undefined],
  ] as const;

  it.each(MUTATIONS)('%s refuses an admin without MFA', async (_label, path, method, body) => {
    const res = await send(buildApp(adminNoMfa), path, method, body);
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('MFA_REQUIRED');
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)('%s refuses a non-platform-admin and an unauthenticated caller', async (_label, path, method, body) => {
    expect((await send(buildApp(partnerUser), path, method, body)).status).toBe(403);
    expect([401, 403]).toContain((await send(buildApp(null), path, method, body)).status);
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('POST /refresh enqueues a manual sync and audits it', async () => {
    const res = await send(buildApp(admin), '/admin/ai-models/refresh', 'POST');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true, jobId: 'ai-model-discovery-sync-platform-manual' });
    expect(enqueueMock).toHaveBeenCalledWith('manual');
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.ai_models.refresh_requested' }));
  });
});
