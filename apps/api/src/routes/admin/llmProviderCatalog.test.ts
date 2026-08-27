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

// Only `runFidelityCheck` is stubbed: the route branches on the harness's REAL
// error classes, so a locally re-declared `LlmEgressViolationError` here would
// make the instanceof check pass against a class the harness never throws.
vi.mock('../../services/llm/providerFidelityHarness', async () => {
  const actual = await vi.importActual<typeof import('../../services/llm/providerFidelityHarness')>(
    '../../services/llm/providerFidelityHarness',
  );
  return { ...actual, runFidelityCheck: runFidelityCheckMock };
});

const { createAuditLogAsyncMock, captureExceptionMock } = vi.hoisted(() => ({
  createAuditLogAsyncMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: createAuditLogAsyncMock,
}));

vi.mock('../../services/sentry', async () => {
  const actual = await vi.importActual<typeof import('../../services/sentry')>('../../services/sentry');
  return { ...actual, captureException: captureExceptionMock };
});

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
import { LlmEgressViolationError } from '../../services/llm/providerFidelityHarness';
import { SsrfBlockedError } from '../../services/urlSafety';
import { LlmProviderCatalogError } from '../../services/llmProviderCatalog';

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

  it('rejects an empty model map before calling the service', async () => {
    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`,
      'POST',
      { baseUrl: 'https://llm.example.test/v1', authMode: 'bearer', modelMap: {} },
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.createRevision).not.toHaveBeenCalled();
  });

  it('audits the requested status value, not just the method and path', async () => {
    await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/status`,
      'PATCH',
      { status: 'delisted' },
    );

    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.llm_provider_catalog.status_changed',
      resourceId: ENTRY_ID,
      details: expect.objectContaining({ status: 'delisted' }),
      result: 'success',
    }));
  });

  it('audits which revision was activated', async () => {
    await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/${ENTRY_ID}/activate`,
      'POST',
      { revisionId: REVISION_ID },
    );

    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.llm_provider_catalog.revision_activated',
      resourceId: ENTRY_ID,
      details: expect.objectContaining({ revisionId: REVISION_ID }),
      result: 'success',
    }));
  });

  it('does not report a passing fidelity check as a provider failure when the write fails', async () => {
    const writeError = new Error('deadlock detected');
    serviceMocks.recordVerification.mockRejectedValue(writeError);

    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
      'POST',
      { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(TEST_API_KEY);
    expect(text).not.toContain('Fidelity check failed');
    expect(captureExceptionMock).toHaveBeenCalledWith(writeError, undefined, expect.any(Object));
  });

  it('reports the harness failure to Sentry when the fidelity check throws', async () => {
    const harnessError = new Error('upstream unreachable');
    runFidelityCheckMock.mockRejectedValue(harnessError);

    const response = await jsonRequest(
      buildApp(platformAdmin),
      `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
      'POST',
      { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
    );

    expect(response.status).toBe(502);
    expect(captureExceptionMock).toHaveBeenCalledWith(harnessError, undefined, expect.any(Object));
  });

  describe('verify route guards', () => {
    it('404s without running the harness when the revision does not exist', async () => {
      serviceMocks.getCatalogRevisionById.mockResolvedValue(null);

      const response = await jsonRequest(
        buildApp(platformAdmin),
        `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
        'POST',
        { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
      );

      expect(response.status).toBe(404);
      // The transient key must not reach an outbound client for a revision the
      // caller cannot even name.
      expect(runFidelityCheckMock).not.toHaveBeenCalled();
      expect(serviceMocks.recordVerification).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(TEST_API_KEY);
    });

    it('400s without running the harness when the model is not mapped by the revision', async () => {
      const response = await jsonRequest(
        buildApp(platformAdmin),
        `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
        'POST',
        { modelId: 'claude-opus-4-8', apiKey: TEST_API_KEY },
      );

      expect(response.status).toBe(400);
      // Without this guard the harness would be handed `undefined.providerModel`
      // — and a verification could be banked against a model the revision never
      // mapped, which the activation gate would then read as satisfied.
      expect(runFidelityCheckMock).not.toHaveBeenCalled();
      expect(serviceMocks.recordVerification).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(TEST_API_KEY);
    });
  });

  describe('blocked egress verdicts', () => {
    const egressCases = [
      [
        'an origin-pinning refusal from the harness fetch',
        () => new LlmEgressViolationError(
          'blocked egress to http://169.254.169.254; this client is pinned to https://llm.example.test',
        ),
      ],
      [
        'an SSRF policy rejection from safeFetch',
        () => new SsrfBlockedError(
          'all resolved IPs for llm.example.test are private/loopback/link-local',
        ),
      ],
    ] as const;

    it.each(egressCases)(
      'reports %s as a 400 egress_blocked verdict, not a generic upstream 502',
      async (_label, makeError) => {
        const error = makeError();
        runFidelityCheckMock.mockRejectedValue(error);

        const response = await jsonRequest(
          buildApp(platformAdmin),
          `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
          'POST',
          { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
        );

        // 502 "the provider failed its fidelity check" sends the operator to
        // the provider; this is OUR egress policy refusing the base URL, which
        // is a different diagnosis and their own to fix.
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'egress_blocked' });
        expect(serviceMocks.recordVerification).not.toHaveBeenCalled();
        expect(captureExceptionMock).toHaveBeenCalledWith(
          error,
          undefined,
          expect.objectContaining({ stage: 'egress_blocked' }),
        );
        expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
          action: 'platform_admin.llm_provider_catalog.verify_egress_blocked',
          resourceId: ENTRY_ID,
          details: expect.objectContaining({
            revisionId: REVISION_ID,
            modelId: 'claude-sonnet-4-6',
          }),
        }));
      },
    );

    it('redacts the transient key from the egress-blocked response and audit row', async () => {
      runFidelityCheckMock.mockRejectedValue(
        new LlmEgressViolationError(`blocked egress while presenting ${TEST_API_KEY}`),
      );

      const response = await jsonRequest(
        buildApp(platformAdmin),
        `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
        'POST',
        { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
      );

      expect(await response.text()).not.toContain(TEST_API_KEY);
      expect(JSON.stringify(createAuditLogAsyncMock.mock.calls)).not.toContain(TEST_API_KEY);
    });

    it('still reports an ordinary harness failure as a 502', async () => {
      runFidelityCheckMock.mockRejectedValue(new Error('upstream returned 500'));

      const response = await jsonRequest(
        buildApp(platformAdmin),
        `/admin/llm-provider-catalog/revisions/${REVISION_ID}/verify`,
        'POST',
        { modelId: 'claude-sonnet-4-6', apiKey: TEST_API_KEY },
      );

      expect(response.status).toBe(502);
      expect(createAuditLogAsyncMock).not.toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.llm_provider_catalog.verify_egress_blocked',
      }));
    });
  });

  describe('authoring audit trail', () => {
    it('audits the slug of a created catalog entry', async () => {
      await jsonRequest(
        buildApp(platformAdmin),
        '/admin/llm-provider-catalog',
        'POST',
        { slug: 'openrouter', name: 'OpenRouter' },
      );

      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.llm_provider_catalog.entry_created',
        resourceId: ENTRY_ID,
        details: expect.objectContaining({ slug: 'openrouter', name: 'OpenRouter' }),
        result: 'success',
      }));
    });

    it('audits the base URL host a new revision points partner prompts at', async () => {
      await jsonRequest(
        buildApp(platformAdmin),
        `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`,
        'POST',
        { baseUrl: 'https://llm.example.test/v1', authMode: 'bearer', modelMap },
      );

      // The base URL is the value that decides where partner prompts go, and
      // catalog authoring has no four-eyes approval — the middleware's
      // method+path row cannot tell two revisions apart.
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.llm_provider_catalog.revision_created',
        resourceId: ENTRY_ID,
        details: expect.objectContaining({
          revisionId: REVISION_ID,
          revision: 1,
          baseUrlHost: 'llm.example.test',
        }),
        result: 'success',
      }));
    });

    it.each([
      ['create entry', '/admin/llm-provider-catalog', { slug: 'x', name: 'X' }, 'createCatalogEntry', 'entry_created'],
      [
        'create revision',
        `/admin/llm-provider-catalog/${ENTRY_ID}/revisions`,
        { baseUrl: 'https://llm.example.test/v1', authMode: 'bearer', modelMap },
        'createRevision',
        'revision_created',
      ],
    ] as const)('does not audit a rejected %s as a success', async (_label, path, body, mock, action) => {
      serviceMocks[mock].mockRejectedValue(
        new LlmProviderCatalogError('Base URL host is not a permitted egress target.', 400),
      );

      const response = await jsonRequest(buildApp(platformAdmin), path, 'POST', body);

      expect(response.status).toBe(400);
      expect(createAuditLogAsyncMock).not.toHaveBeenCalledWith(expect.objectContaining({
        action: `platform_admin.llm_provider_catalog.${action}`,
      }));
    });
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
