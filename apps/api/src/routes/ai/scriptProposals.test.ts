import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadScriptProposalDetail = vi.fn();
vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
const flag = { enabled: true };
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  aiScriptAuthoringEnabled: () => flag.enabled,
}));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '22222222-2222-4222-8222-222222222222' },
        scope: 'organization', orgId: '11111111-1111-4111-8111-111111111111',
        partnerId: null, accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
        token: { mfa: true },
      });
      await next();
    },
  };
});

import { aiScriptProposalRoutes } from './scriptProposals';

const ID = '44444444-4444-4444-8444-444444444444';
beforeEach(() => { vi.clearAllMocks(); flag.enabled = true; });

describe('GET /:id', () => {
  it('returns the DTO for an authorised caller', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID } } });
    const res = await aiScriptProposalRoutes.request(`/${ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposal: { id: ID } });
  });

  it('404s an unknown proposal', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await aiScriptProposalRoutes.request(`/${ID}`)).status).toBe(404);
  });

  it('403s a caller who is neither requester nor a live approvals:decide holder', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'forbidden' });
    const res = await aiScriptProposalRoutes.request(`/${ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('400s a non-uuid id before touching the service', async () => {
    expect((await aiScriptProposalRoutes.request('/not-a-uuid')).status).toBe(400);
    expect(loadScriptProposalDetail).not.toHaveBeenCalled();
  });

  it('is dark (404 feature_disabled) when the wave flag is off', async () => {
    flag.enabled = false;
    const res = await aiScriptProposalRoutes.request(`/${ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
    expect(loadScriptProposalDetail).not.toHaveBeenCalled();
  });
});
