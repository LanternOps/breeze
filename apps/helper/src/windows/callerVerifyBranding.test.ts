import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const helperRequestMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('../lib/helperFetch', () => ({ helperRequest: (...a: unknown[]) => helperRequestMock(...a) }));

import { loadCallerBranding } from './callerVerifyBranding';

const cfg = { api_url: 'https://api.example.com/', agent_id: 'a' };

describe('loadCallerBranding', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(cfg);
    helperRequestMock.mockReset();
  });

  it('GETs /api/v1/helper/config and returns branding', async () => {
    helperRequestMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({ branding: { partnerName: 'Northwind', logoUrl: 'https://x.example/l.png' } }),
    });
    await expect(loadCallerBranding()).resolves.toEqual({ partnerName: 'Northwind', logoUrl: 'https://x.example/l.png' });
    expect(helperRequestMock).toHaveBeenCalledWith(cfg, 'https://api.example.com/api/v1/helper/config', { method: 'GET' });
  });

  it('drops non-https logos but keeps the partner name', async () => {
    helperRequestMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({ branding: { partnerName: 'N', logoUrl: 'javascript:alert(1)' } }),
    });
    await expect(loadCallerBranding()).resolves.toEqual({ partnerName: 'N', logoUrl: null });
  });

  it('returns null for missing, malformed or failed branding', async () => {
    helperRequestMock.mockResolvedValue({ ok: true, status: 200, body: '{}' });
    await expect(loadCallerBranding()).resolves.toBeNull();
    helperRequestMock.mockResolvedValue({ ok: true, status: 200, body: JSON.stringify({ branding: { partnerName: 5 } }) });
    await expect(loadCallerBranding()).resolves.toBeNull();
    helperRequestMock.mockResolvedValue({ ok: false, status: 500, body: '' });
    await expect(loadCallerBranding()).resolves.toBeNull();
    helperRequestMock.mockRejectedValue(new Error('offline'));
    await expect(loadCallerBranding()).resolves.toBeNull();
    invokeMock.mockRejectedValue(new Error('no config'));
    await expect(loadCallerBranding()).resolves.toBeNull();
  });
});
