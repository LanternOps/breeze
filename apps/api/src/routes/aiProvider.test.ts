import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({
  permissionDenied: false,
  mfaDenied: false,
}));

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

const authState: { value: any } = {
  value: {
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
    scope: 'partner',
    partnerId: '22222222-2222-4222-8222-222222222222',
    partnerOrgAccess: 'all',
  },
};

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', authState.value);
    await next();
  },
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (authGates.permissionDenied) return c.json({ error: 'Permission denied' }, 403);
    await next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (authGates.mfaDenied) return c.json({ error: 'MFA required' }, 403);
    await next();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: captureExceptionMock,
}));

vi.mock('../services/aiCostTracker', () => ({
  OFFERABLE_AI_MODELS: Object.freeze(['claude-sonnet-4-6', 'claude-haiku-4-5']),
}));

vi.mock('../services/partnerLlmConfig', () => {
  class PartnerLlmError extends Error {
    constructor(message: string, readonly status: 400 | 409 | 500 | 503) {
      super(message);
      this.name = 'PartnerLlmError';
    }
  }
  return {
    PartnerLlmError,
    savePartnerLlmKey: vi.fn(),
    getPartnerLlmStatus: vi.fn(),
    updatePartnerLlmConfig: vi.fn(),
    updatePartnerLlmEndpoint: vi.fn(),
    deletePartnerLlmConfig: vi.fn(),
  };
});

const catalogFlagState = { enabled: true };

vi.mock('../services/llm/llmConfigResolver', () => ({
  isLlmProviderCatalogEnabled: () => catalogFlagState.enabled,
}));

vi.mock('../services/llmProviderCatalog', () => ({
  getListedProviders: vi.fn(),
}));

import { aiProviderRoutes } from './aiProvider';
import { requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
  updatePartnerLlmEndpoint,
} from '../services/partnerLlmConfig';
import { getListedProviders } from '../services/llmProviderCatalog';

function postKey(apiKey = 'sk-ant-api03-route-test-key-1234567890') {
  return aiProviderRoutes.request('/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

const CATALOG_ENTRY_ID = '55555555-5555-4555-8555-555555555555';

function postEndpoint(body: Record<string, unknown> = { catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true }) {
  return aiProviderRoutes.request('/endpoint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AI provider routes', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear();
    vi.mocked(writeRouteAudit).mockClear();
    vi.mocked(getPartnerLlmStatus).mockClear();
    vi.mocked(savePartnerLlmKey).mockClear();
    vi.mocked(updatePartnerLlmConfig).mockClear();
    vi.mocked(updatePartnerLlmEndpoint).mockClear();
    vi.mocked(deletePartnerLlmConfig).mockClear();
    vi.mocked(getListedProviders).mockClear();
    vi.mocked(getListedProviders).mockResolvedValue([]);
    vi.mocked(updatePartnerLlmEndpoint).mockResolvedValue({
      catalogEntryId: CATALOG_ENTRY_ID,
      configVersion: 2,
      slug: 'openrouter',
      revision: 3,
    });
    catalogFlagState.enabled = true;
    authGates.permissionDenied = false;
    authGates.mfaDenied = false;
    authState.value = {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
      scope: 'partner',
      partnerId: '22222222-2222-4222-8222-222222222222',
      partnerOrgAccess: 'all',
    };
    vi.mocked(getPartnerLlmStatus).mockResolvedValue({
      configured: true,
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: 'claude-sonnet-4-6',
      status: 'active',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      lastError: null,
      catalogEntryId: null,
      apiKey: 'must-not-leak',
      keyFingerprint: 'must-not-leak-either',
    } as any);
    vi.mocked(savePartnerLlmKey).mockResolvedValue({
      last4: '7890',
      model: 'claude-sonnet-4-6',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      configVersion: 3,
    });
    vi.mocked(updatePartnerLlmConfig).mockResolvedValue({
      defaultModel: 'claude-haiku-4-5',
      configVersion: 4,
    });
    vi.mocked(deletePartnerLlmConfig).mockResolvedValue(true);
  });

  it('returns 403 when the authenticated request has no partner context', async () => {
    authState.value = {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
      partnerId: null,
    };

    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(403);
    expect(getPartnerLlmStatus).not.toHaveBeenCalled();
  });

  const handlerRequests = [
    ['GET /', () => aiProviderRoutes.request('/', { method: 'GET' })],
    ['POST /key', () => postKey()],
    ['PATCH /', () => aiProviderRoutes.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    })],
    ['DELETE /', () => aiProviderRoutes.request('/', { method: 'DELETE' })],
    ['POST /endpoint', () => postEndpoint()],
  ] as const;

  it.each(handlerRequests)('%s rejects organization-scoped auth even when it carries a partnerId', async (_name, request) => {
    authState.value = {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
      scope: 'organization',
      orgId: '33333333-3333-4333-8333-333333333333',
      partnerId: '22222222-2222-4222-8222-222222222222',
      partnerOrgAccess: null,
    };

    const response = await request();

    expect(response.status).toBe(403);
    expect(getPartnerLlmStatus).not.toHaveBeenCalled();
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
    expect(updatePartnerLlmConfig).not.toHaveBeenCalled();
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
    expect(deletePartnerLlmConfig).not.toHaveBeenCalled();
  });

  it.each(handlerRequests)('%s rejects partner auth limited to selected organizations', async (_name, request) => {
    authState.value = {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
      scope: 'partner',
      partnerId: '22222222-2222-4222-8222-222222222222',
      partnerOrgAccess: 'selected',
    };

    const response = await request();

    expect(response.status).toBe(403);
    expect(getPartnerLlmStatus).not.toHaveBeenCalled();
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
    expect(updatePartnerLlmConfig).not.toHaveBeenCalled();
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
    expect(deletePartnerLlmConfig).not.toHaveBeenCalled();
  });

  it.each(handlerRequests)('%s stops at the billing permission gate before calling the service', async (_name, request) => {
    authGates.permissionDenied = true;

    const response = await request();

    expect(response.status).toBe(403);
    expect(getPartnerLlmStatus).not.toHaveBeenCalled();
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
    expect(updatePartnerLlmConfig).not.toHaveBeenCalled();
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
    expect(deletePartnerLlmConfig).not.toHaveBeenCalled();
  });

  it('registers every handler with the billing manage permission', async () => {
    expect(requirePermission).toHaveBeenCalledTimes(5);
    expect(requirePermission).toHaveBeenCalledWith('billing', 'manage');
  });

  it('GET / uses read-specific copy when full partner org access is missing', async () => {
    authState.value.partnerOrgAccess = 'selected';

    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      'Viewing the partner AI provider configuration requires full partner org access (orgAccess must be "all")',
    );
  });

  it('requires MFA for POST /key', async () => {
    authGates.mfaDenied = true;

    const response = await postKey();

    expect(response.status).toBe(403);
    expect(savePartnerLlmKey).not.toHaveBeenCalled();
  });

  it('requires MFA for DELETE /', async () => {
    authGates.mfaDenied = true;

    const response = await aiProviderRoutes.request('/', { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect(deletePartnerLlmConfig).not.toHaveBeenCalled();
  });

  it('GET / whitelists status fields and never returns the key or fingerprint', async () => {
    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('must-not-leak');
    expect(JSON.parse(text)).toEqual({
      configured: true,
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: 'claude-sonnet-4-6',
      status: 'active',
      verifiedAt: '2026-08-23T12:00:00.000Z',
      lastError: null,
      effectiveDefaultModel: 'claude-sonnet-4-6',
      supportedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      catalogEntryId: null,
      catalog: [],
    });
  });

  // The resolver routes `defaultModel ?? resolveDefaultModel()`. Without the
  // effective model on this payload the UI cannot tell that an unpinned
  // partner is about to send a model the selected endpoint no longer verifies,
  // so it renders no `model_unverified` banner while AI 503s.
  it('GET / reports the effective default model the resolver will use when the partner pinned none', async () => {
    const previous = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'deployment-default-model';
    try {
      vi.mocked(getPartnerLlmStatus).mockResolvedValue({
        configured: true,
        provider: 'anthropic',
        keyLast4: '7890',
        defaultModel: null,
        status: 'active',
        verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
        lastError: null,
        catalogEntryId: null,
      });

      const response = await aiProviderRoutes.request('/', { method: 'GET' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.defaultModel).toBeNull();
      expect(body.effectiveDefaultModel).toBe('deployment-default-model');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previous;
    }
  });

  it('GET / returns the listed catalog with verified models intersected against the model map, and the current selection', async () => {
    vi.mocked(getPartnerLlmStatus).mockResolvedValue({
      configured: true,
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: 'claude-sonnet-4-6',
      status: 'active',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      lastError: null,
      catalogEntryId: CATALOG_ENTRY_ID,
    });
    vi.mocked(getListedProviders).mockResolvedValue([
      {
        entryId: CATALOG_ENTRY_ID,
        slug: 'openrouter',
        name: 'OpenRouter',
        revisionId: '66666666-6666-4666-8666-666666666666',
        revision: 3,
        baseUrl: 'https://openrouter.ai/api/v1',
        authMode: 'x-api-key',
        modelMap: {
          'claude-sonnet-4-6': {
            providerModel: 'anthropic/claude-sonnet-4-6',
            inputCentsPerM: 300,
            outputCentsPerM: 1500,
            cacheReadCentsPerM: 30,
            cacheWriteCentsPerM: 375,
          },
        },
        dataNote: 'Prompts transit OpenRouter.',
        // A stale verification for a model no longer in modelMap must not leak
        // into the route's response — the route intersects with modelMap keys.
        verifiedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      },
    ] as any);

    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.catalogEntryId).toBe(CATALOG_ENTRY_ID);
    expect(body.catalog).toEqual([{
      entryId: CATALOG_ENTRY_ID,
      slug: 'openrouter',
      name: 'OpenRouter',
      dataNote: 'Prompts transit OpenRouter.',
      models: ['claude-sonnet-4-6'],
    }]);
  });

  it('GET / never offers a prototype-named verified model that the model map does not own', async () => {
    vi.mocked(getListedProviders).mockResolvedValue([
      {
        entryId: CATALOG_ENTRY_ID,
        slug: 'openrouter',
        name: 'OpenRouter',
        revisionId: '66666666-6666-4666-8666-666666666666',
        revision: 3,
        baseUrl: 'https://openrouter.ai/api/v1',
        authMode: 'x-api-key',
        modelMap: {
          'claude-sonnet-4-6': {
            providerModel: 'anthropic/claude-sonnet-4-6',
            inputCentsPerM: 300,
            outputCentsPerM: 1500,
            cacheReadCentsPerM: 30,
            cacheWriteCentsPerM: 375,
          },
        },
        dataNote: 'Prompts transit OpenRouter.',
        // `modelMap` is a jsonb round-trip, so `'constructor' in modelMap` is
        // TRUE by inheritance: an `in` intersection offers the UI a model the
        // revision has no wire id or pricing for, and the resolver then fails
        // closed on every session that selects it (#3922 W3 review round 2).
        verifiedModels: ['claude-sonnet-4-6', 'constructor', '__proto__', 'toString'],
      },
    ] as any);

    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.catalog[0].models).toEqual(['claude-sonnet-4-6']);
  });

  it('GET / returns an empty catalog and never calls getListedProviders when the flag is off', async () => {
    catalogFlagState.enabled = false;

    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.catalog).toEqual([]);
    expect(getListedProviders).not.toHaveBeenCalled();
  });

  it('GET / returns supportedModels from the cost-tracker registry for the model select', async () => {
    const response = await aiProviderRoutes.request('/', { method: 'GET' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.supportedModels).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5']);
  });

  it('POST /key maps PartnerLlmError to its typed HTTP status', async () => {
    vi.mocked(savePartnerLlmKey).mockRejectedValue(
      new PartnerLlmError('Anthropic denied access for that API key.', 409),
    );

    const response = await postKey();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Anthropic denied access for that API key.' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('POST /key captures mapped PartnerLlmError responses at 5xx', async () => {
    const error = new PartnerLlmError('Anthropic could not verify the API key right now.', 503);
    vi.mocked(savePartnerLlmKey).mockRejectedValue(error);

    const response = await postKey();

    expect(response.status).toBe(503);
    expect(captureException).toHaveBeenCalledWith(error, undefined, { service: 'aiProvider' });
  });

  it('POST /key saves and audits only last4 and configVersion', async () => {
    const submittedKey = 'sk-ant-api03-route-test-key-1234567890';
    const response = await postKey(submittedKey);

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(submittedKey);
    expect(savePartnerLlmKey).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      apiKey: 'sk-ant-api03-route-test-key-1234567890',
      userId: '11111111-1111-4111-8111-111111111111',
    });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: null,
      action: 'ai_provider.connected',
      resourceType: 'partner',
      resourceId: '22222222-2222-4222-8222-222222222222',
      details: { last4: '7890', configVersion: 3 },
    });
    expect(JSON.stringify(vi.mocked(writeRouteAudit).mock.calls[0])).not.toContain('sk-ant-api03');
  });

  it('PATCH / updates the model and audits the mutation', async () => {
    const response = await aiProviderRoutes.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    });

    expect(response.status).toBe(200);
    expect(updatePartnerLlmConfig).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      defaultModel: 'claude-haiku-4-5',
    });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ai_provider.updated',
    }));
  });

  it('PATCH / deliberately succeeds without requiring MFA because only key writes and removal are gated', async () => {
    authGates.mfaDenied = true;

    const response = await aiProviderRoutes.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    });

    expect(response.status).toBe(200);
    expect(updatePartnerLlmConfig).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      defaultModel: 'claude-haiku-4-5',
    });
  });

  it('PATCH / captures mapped PartnerLlmError responses at 5xx', async () => {
    const error = new PartnerLlmError('Could not update the Anthropic configuration.', 500);
    vi.mocked(updatePartnerLlmConfig).mockRejectedValue(error);

    const response = await aiProviderRoutes.request('/', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    });

    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(error, undefined, { service: 'aiProvider' });
  });

  it('DELETE / removes the config and audits the disconnect', async () => {
    const response = await aiProviderRoutes.request('/', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(deletePartnerLlmConfig).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ai_provider.disconnected',
    }));
  });

  it('DELETE / remains idempotent without auditing when no config existed', async () => {
    vi.mocked(deletePartnerLlmConfig).mockResolvedValue(false);

    const response = await aiProviderRoutes.request('/', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, status: 'platform' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('requires MFA for POST /endpoint', async () => {
    authGates.mfaDenied = true;

    const response = await postEndpoint();

    expect(response.status).toBe(403);
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
  });

  it('POST /endpoint 404s when the catalog flag is off, without calling the service', async () => {
    catalogFlagState.enabled = false;

    const response = await postEndpoint();

    expect(response.status).toBe(404);
    expect(updatePartnerLlmEndpoint).not.toHaveBeenCalled();
  });

  it('POST /endpoint still CLEARS a selection when the catalog flag is off', async () => {
    catalogFlagState.enabled = false;
    vi.mocked(updatePartnerLlmEndpoint).mockResolvedValueOnce({
      catalogEntryId: null,
      configVersion: 3,
      slug: null,
      revision: null,
    });

    const response = await postEndpoint({ catalogEntryId: null });

    // The flag gates SELECTING, never CLEARING. On a rollback a pinned partner
    // resolves `catalog_disabled` (AI dead) and cannot even rotate their key;
    // `catalogEntryId: null` is the documented escape hatch, and gating it
    // behind the flag left DELETE / — which destroys the stored key — as the
    // only recovery.
    expect(response.status).toBe(200);
    expect(updatePartnerLlmEndpoint).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      catalogEntryId: null,
      acknowledgeDataNote: false,
      userId: '11111111-1111-4111-8111-111111111111',
    });
    expect(await response.json()).toEqual({ catalogEntryId: null, configVersion: 3 });
  });

  it('POST /endpoint selects a catalog entry and audits the slug + revision, never the key', async () => {
    const response = await postEndpoint({ catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true });

    expect(response.status).toBe(200);
    expect(updatePartnerLlmEndpoint).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      catalogEntryId: CATALOG_ENTRY_ID,
      acknowledgeDataNote: true,
      userId: '11111111-1111-4111-8111-111111111111',
    });
    expect(await response.json()).toEqual({ catalogEntryId: CATALOG_ENTRY_ID, configVersion: 2 });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: null,
      action: 'ai_provider.endpoint_changed',
      resourceType: 'partner',
      resourceId: '22222222-2222-4222-8222-222222222222',
      details: {
        catalogEntryId: CATALOG_ENTRY_ID,
        slug: 'openrouter',
        revision: 3,
        configVersion: 2,
      },
    });
  });

  it('POST /endpoint reverts to direct Anthropic with catalogEntryId: null', async () => {
    vi.mocked(updatePartnerLlmEndpoint).mockResolvedValue({
      catalogEntryId: null,
      configVersion: 3,
      slug: null,
      revision: null,
    });

    const response = await postEndpoint({ catalogEntryId: null });

    expect(response.status).toBe(200);
    expect(updatePartnerLlmEndpoint).toHaveBeenCalledWith({
      partnerId: '22222222-2222-4222-8222-222222222222',
      catalogEntryId: null,
      acknowledgeDataNote: false,
      userId: '11111111-1111-4111-8111-111111111111',
    });
    expect(await response.json()).toEqual({ catalogEntryId: null, configVersion: 3 });
  });

  it('POST /endpoint maps a delisted-entry rejection to its typed status without auditing', async () => {
    vi.mocked(updatePartnerLlmEndpoint).mockRejectedValue(
      new PartnerLlmError('That endpoint was delisted and is no longer available for selection.', 409),
    );

    const response = await postEndpoint();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'That endpoint was delisted and is no longer available for selection.',
    });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('POST /endpoint maps a missing-consent rejection to 400', async () => {
    vi.mocked(updatePartnerLlmEndpoint).mockRejectedValue(
      new PartnerLlmError('You must acknowledge the data-handling note for this endpoint before selecting it.', 400),
    );

    const response = await postEndpoint({ catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: false });

    expect(response.status).toBe(400);
  });

  it('POST /endpoint maps a probe failure to its typed status and persists nothing (route delegates persistence to the service)', async () => {
    const error = new PartnerLlmError('Could not reach that endpoint to verify the key. Try again shortly.', 503);
    vi.mocked(updatePartnerLlmEndpoint).mockRejectedValue(error);

    const response = await postEndpoint();

    expect(response.status).toBe(503);
    expect(captureException).toHaveBeenCalledWith(error, undefined, { service: 'aiProvider' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
