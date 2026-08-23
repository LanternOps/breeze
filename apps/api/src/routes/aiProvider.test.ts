import { beforeEach, describe, expect, it, vi } from 'vitest';

const authGates = vi.hoisted(() => ({
  permissionDenied: false,
  mfaDenied: false,
}));

const authState: { value: any } = {
  value: {
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
    partnerId: '22222222-2222-4222-8222-222222222222',
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
    deletePartnerLlmConfig: vi.fn(),
  };
});

import { aiProviderRoutes } from './aiProvider';
import { writeRouteAudit } from '../services/auditEvents';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
} from '../services/partnerLlmConfig';

function postKey(apiKey = 'sk-ant-api03-route-test-key-1234567890') {
  return aiProviderRoutes.request('/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

describe('AI provider routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authGates.permissionDenied = false;
    authGates.mfaDenied = false;
    authState.value = {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', name: 'Admin' },
      partnerId: '22222222-2222-4222-8222-222222222222',
    };
    vi.mocked(getPartnerLlmStatus).mockResolvedValue({
      configured: true,
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: 'claude-sonnet-4-6',
      status: 'active',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      lastError: null,
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
    vi.mocked(deletePartnerLlmConfig).mockResolvedValue(undefined);
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
    });
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

  it('POST /key saves and audits only last4 and configVersion', async () => {
    const response = await postKey();

    expect(response.status).toBe(200);
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

  it('DELETE / removes the config and audits the disconnect', async () => {
    const response = await aiProviderRoutes.request('/', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(deletePartnerLlmConfig).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ai_provider.disconnected',
    }));
  });
});
