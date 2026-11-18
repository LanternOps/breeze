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

  it('reads branding.logo.sha256 (W04) and ignores anything but 64 lowercase hex of a known type', async () => {
    const sha = 'c96253573225f1fa2044af43896a96056903b359eed7af9fad90bd626127ba99';
    const reply = (logo: unknown) =>
      helperRequestMock.mockResolvedValue({
        ok: true,
        status: 200,
        body: JSON.stringify({ branding: { partnerName: 'N', logoUrl: null, logo } }),
      });
    reply({ sha256: sha, mime: 'image/png' });
    await expect(loadCallerBranding()).resolves.toEqual({ partnerName: 'N', logoUrl: null, logoSha256: sha });
    for (const bad of [
      null,
      { sha256: sha.toUpperCase(), mime: 'image/png' },
      { sha256: sha.slice(1), mime: 'image/png' },
      { sha256: sha, mime: 'image/svg+xml' },
      { sha256: 5, mime: 'image/png' },
      'c96253',
    ]) {
      reply(bad);
      const b = await loadCallerBranding();
      expect(b?.logoSha256 ?? null, JSON.stringify(bad)).toBeNull();
      expect(b?.partnerName).toBe('N');
    }
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
