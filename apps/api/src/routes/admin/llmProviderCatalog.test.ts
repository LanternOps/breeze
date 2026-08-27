import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const TEST_API_KEY = 'catalog-test-key-never-return-this';

const { serviceMocks, runFidelityCheckMock } = vi.hoisted(() => ({
  serviceMocks: {
    getAllCatalogEntriesForAdmin: vi.fn(),
    getCatalogRevisionById: vi.fn(),
    createCatalogEntry: vi.fn(),
    createRevision: vi.fn(),
    activateRevision: vi.fn(),
    setEntryStatus: vi.fn(),
    recordVerification: vi.fn(),
  },
  runFidelityCheckMock: vi.fn(),
}));

vi.mock('../../services/llmProviderCatalog', () => ({
  ...serviceMocks,
  LlmProviderCatalogError: class LlmProviderCatalogError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));

vi.mock('../../services/llm/providerFidelityHarness', () => ({
  runFidelityCheck: runFidelityCheckMock,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

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

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  user: {
    id: ADMIN_ID,
    email: 'admin@breeze.test',
    name: 'Platform Admin',
    isPlatformAdmin: true,
  },
  token: { mfa: true },
};
const platformAdminNoMfa: FakeAuth = { ...platformAdmin, token: { mfa: false } };
const nonPlatformAdmin: FakeAuth = {
  user: {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'partner@breeze.test',
    name: 'Partner Admin',
    isPlatformAdmin: false,
  },
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

function jsonRequest(app: Hono, path: string, method: 'POST' | 'PATCH', body: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const modelMap = {
  'claude-sonnet-4-6': {
    providerModel: 'provider/sonnet',
    inputCentsPerM: 300,
    outputCentsPerM: 1500,
    cacheReadCentsPerM: 30,
    cacheWriteCentsPerM: 375,
  },
};

const revisionLookup = {
  revisionId: REVISION_ID,
  entryId: ENTRY_ID,
  baseUrl: 'https://llm.example.test/v1',
  authMode: 'bearer' as const,
  modelMap,
};

describe('admin LLM provider catalog routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getAllCatalogEntriesForAdmin.mockResolvedValue([]);
    serviceMocks.getCatalogRevisionById.mockResolvedValue(revisionLookup);
    serviceMocks.createCatalogEntry.mockResolvedValue({ id: ENTRY_ID });
    serviceMocks.createRevision.mockResolvedValue({ id: REVISION_ID, revision: 1 });
    serviceMocks.activateRevision.mockResolvedValue(undefined);
    serviceMocks.setEntryStatus.mockResolvedValue(undefined);
    serviceMocks.recordVerification.mockResolvedValue(undefined);
    runFidelityCheckMock.mockResolvedValue({
      passed: true,
      steps: [{ name: 'messages', ok: true }],
      harnessVersion: '1',
    });
  });

  describe('authorization', () => {
    it('rejects a non-platform-admin request at the mounted admin middleware', async () => {
      const response = await buildApp(nonPlatformAdmin).request('/admin/llm-provider-catalog');
      expect(response.status).toBe(403);
      expect(serviceMocks.getAllCatalogEntriesForAdmin).not.toHaveBeenCalled();
    });

    it('allows a catalog read without MFA', async () => {
      const response = await buildApp(platformAdminNoMfa).request('/admin/llm-provider-catalog');
      expect(response.status).toBe(200);
      expect(serviceMocks.getAllCatalogEntriesForAdmin).toHaveBeenCalledOnce();
    });

    it.each([
      ['create entry', '/admin/llm-provider-catalog', 'POST', { slug: 'example', name: 'Example' }],
      ['create revision', `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`, 'POST', {
        baseUrl: 'https://llm.example.test/v1', authMode: 'bearer', modelMap,
      }],
      ['activate revision', `/admin/llm-provider-catalog/${ENTRY_ID}/activate`, 'POST', {
        revisionId: REVISION_ID,
      }],
      ['change status', `/admin/llm-provider-catalog/${ENTRY_ID}/status`, 'PATCH', {
        status: 'listed',
      }],
      ['verify revision', `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`, 'POST', {
        modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY,
      }],
    ] as const)('requires MFA to %s', async (_label, path, method, body) => {
      const response = await jsonRequest(
        buildApp(platformAdminNoMfa),
        path,
        method,
        body,
      );
      expect(response.status).toBe(403);
      expect((await response.json() as { code: string }).code).toBe('MFA_REQUIRED');
    });
  });

  it('GET / returns all entries with revisions and verification summaries', async () => {
    const entries = [{ entryId: ENTRY_ID, revisions: [], status: 'draft' }];
    serviceMocks.getAllCatalogEntriesForAdmin.mockResolvedValue(entries);

    const response = await buildApp(platformAdmin).request('/admin/llm-provider-catalog');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(entries);
  });

  it('POST / creates a draft catalog entry', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      '/admin/llm-provider-catalog',
      'POST',
      { slug: 'example', name: 'Example', notes: 'Internal note' },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: ENTRY_ID });
    expect(serviceMocks.createCatalogEntry).toHaveBeenCalledWith({
      slug: 'example',
      name: 'Example',
      notes: 'Internal note',
    });
  });

  it('POST /:entryId/revisions creates a validated revision for the authenticated admin', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`,
      'POST',
      {
        baseUrl: 'https://llm.example.test/v1',
        authMode: 'bearer',
        modelMap,
        dataNote: 'Provider retains prompts for 30 days.',
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: REVISION_ID, revision: 1 });
    expect(serviceMocks.createRevision).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap,
      dataNote: 'Provider retains prompts for 30 days.',
      createdBy: ADMIN_ID,
    });
  });

  it('POST /:entryId/activate activates the requested revision', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/activate`,
      'POST',
      { revisionId: REVISION_ID },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(serviceMocks.activateRevision).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      revisionId: REVISION_ID,
    });
  });

  it('PATCH /:entryId/status changes catalog visibility', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/status`,
      'PATCH',
      { status: 'listed' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(serviceMocks.setEntryStatus).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      status: 'listed',
    });
  });

  it('POST /revisions/:revisionId/verify runs the harness and records its result without returning the API key', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
      'POST',
      { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      passed: true,
      steps: [{ name: 'messages', ok: true }],
      harnessVersion: '1',
    });
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(runFidelityCheckMock).toHaveBeenCalledWith({
      baseUrl: revisionLookup.baseUrl,
      authMode: revisionLookup.authMode,
      providerModel: 'provider/sonnet',
      apiKey: TEST_API_KEY,
    });
    expect(serviceMocks.recordVerification).toHaveBeenCalledWith({
      revisionId: REVISION_ID,
      modelId: 'claude-sonnet-4-6',
      passed: true,
      detail: {
        steps: [{ name: 'messages', ok: true }],
        harnessVersion: '1',
      },
      verifiedBy: ADMIN_ID,
    });
  });

  it('never leaks the transient API key when the harness throws', async () => {
    runFidelityCheckMock.mockRejectedValue(new Error(`upstream rejected ${TEST_API_KEY}`));

    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
      'POST',
      { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(TEST_API_KEY);
    expect(serviceMocks.recordVerification).not.toHaveBeenCalled();
  });

  it('rejects malformed model pricing before calling the service', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`,
      'POST',
      {
        baseUrl: 'https://llm.example.test/v1',
        authMode: 'bearer',
        modelMap: {
          'claude-sonnet-4-6': { ...modelMap['claude-sonnet-4-6'], inputCentsPerM: -1 },
        },
      },
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.createRevision).not.toHaveBeenCalled();
  });
});
