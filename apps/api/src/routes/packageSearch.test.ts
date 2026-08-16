import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { permissionGate, scopeGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  scopeGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { userId: 'user-123', scope: 'organization', orgId: 'org-123', partnerId: null });
    return next();
  }),
  requireScope: vi.fn(() => async (c: any, next: any) => {
    if (scopeGate.deny) return c.json({ error: 'Wrong scope' }, 403);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  // Deliberately NOT exporting requireMfa usage: this route must not require MFA.
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/packageSearch', () => ({
  DEFAULT_SEARCH_LIMIT: 25,
  searchWingetIndex: vi.fn(),
  searchHomebrew: vi.fn(),
  annotateBreezeTested: vi.fn(),
}));

import { packageSearchRoutes } from './packageSearch';
import { searchWingetIndex, searchHomebrew, annotateBreezeTested } from '../services/packageSearch';
import { requireMfa } from '../middleware/auth';

const app = new Hono();
app.route('/software', packageSearchRoutes);

const WINGET_ROW = {
  platform: 'windows',
  kind: 'winget',
  packageId: 'Google.Chrome',
  name: 'Chrome',
  vendor: 'Google',
  latestVersion: '126.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  permissionGate.deny = false;
  scopeGate.deny = false;
  (annotateBreezeTested as any).mockImplementation(async (r: unknown[]) => r);
});

describe('GET /software/package-search — validation', () => {
  it('rejects a missing platform', async () => {
    const res = await app.request('/software/package-search?q=chrome');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown platform', async () => {
    const res = await app.request('/software/package-search?platform=linux&q=chrome');
    expect(res.status).toBe(400);
  });

  it('rejects q shorter than 2 characters', async () => {
    const res = await app.request('/software/package-search?platform=windows&q=c');
    expect(res.status).toBe(400);
    expect(searchWingetIndex).not.toHaveBeenCalled();
  });

  it('rejects q longer than 100 characters', async () => {
    const res = await app.request(`/software/package-search?platform=windows&q=${'a'.repeat(101)}`);
    expect(res.status).toBe(400);
    expect(searchWingetIndex).not.toHaveBeenCalled();
  });

  it('accepts q at the 2 and 100 character boundaries', async () => {
    (searchWingetIndex as any).mockResolvedValue([]);
    expect((await app.request('/software/package-search?platform=windows&q=ch')).status).toBe(200);
    expect((await app.request(`/software/package-search?platform=windows&q=${'a'.repeat(100)}`)).status).toBe(200);
  });
});

describe('GET /software/package-search — authorization', () => {
  it('403s without DEVICES_READ', async () => {
    permissionGate.deny = true;
    const res = await app.request('/software/package-search?platform=windows&q=chrome');
    expect(res.status).toBe(403);
  });

  it('403s for a disallowed scope', async () => {
    scopeGate.deny = true;
    const res = await app.request('/software/package-search?platform=windows&q=chrome');
    expect(res.status).toBe(403);
  });

  it('does not gate on MFA (read-only public catalog lookup)', async () => {
    (searchWingetIndex as any).mockResolvedValue([]);
    await app.request('/software/package-search?platform=windows&q=chrome');
    expect(requireMfa).not.toHaveBeenCalled();
  });
});

describe('GET /software/package-search — windows (winget)', () => {
  it('returns the winget results under `results` with a limit of 25', async () => {
    (searchWingetIndex as any).mockResolvedValue([WINGET_ROW]);

    const res = await app.request('/software/package-search?platform=windows&q=chrome');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(searchWingetIndex).toHaveBeenCalledWith('chrome', 25);
    expect(searchHomebrew).not.toHaveBeenCalled();
    expect(body).toEqual({ results: [WINGET_ROW] });
    expect(body.degraded).toBeUndefined();
  });

  it('annotates breezeTested from the catalog join', async () => {
    (searchWingetIndex as any).mockResolvedValue([WINGET_ROW]);
    (annotateBreezeTested as any).mockResolvedValue([
      { ...WINGET_ROW, breezeTested: { version: '126.0', testedAt: '2026-08-01T10:00:00.000Z' } },
    ]);

    const res = await app.request('/software/package-search?platform=windows&q=chrome');
    const body = await res.json();

    expect(annotateBreezeTested).toHaveBeenCalledWith([WINGET_ROW]);
    expect(body.results[0].breezeTested).toEqual({ version: '126.0', testedAt: '2026-08-01T10:00:00.000Z' });
  });

  it('still returns results when the annotation query fails', async () => {
    (searchWingetIndex as any).mockResolvedValue([WINGET_ROW]);
    (annotateBreezeTested as any).mockRejectedValue(new Error('catalog down'));

    const res = await app.request('/software/package-search?platform=windows&q=chrome');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [WINGET_ROW] });
  });
});

describe('GET /software/package-search — macos (Homebrew)', () => {
  const BREW_ROW = {
    platform: 'macos',
    kind: 'homebrew_cask',
    packageId: 'google-chrome',
    name: 'Google Chrome',
    vendor: '',
    latestVersion: '126.0',
    description: 'Web browser',
    homepageUrl: 'https://google.com/chrome',
  };

  it('returns brew results without a degraded flag', async () => {
    (searchHomebrew as any).mockResolvedValue({ results: [BREW_ROW], degraded: false });

    const res = await app.request('/software/package-search?platform=macos&q=chrome');
    const body = await res.json();

    expect(searchHomebrew).toHaveBeenCalledWith('chrome', 25);
    expect(searchWingetIndex).not.toHaveBeenCalled();
    expect(body).toEqual({ results: [BREW_ROW] });
    expect('degraded' in body).toBe(false);
  });

  it('surfaces degraded: true with empty results when brew is unreachable', async () => {
    (searchHomebrew as any).mockResolvedValue({ results: [], degraded: true });

    const res = await app.request('/software/package-search?platform=macos&q=chrome');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [], degraded: true });
  });

  it('never annotates brew results with breezeTested (winget-only evidence)', async () => {
    (searchHomebrew as any).mockResolvedValue({ results: [BREW_ROW], degraded: false });
    await app.request('/software/package-search?platform=macos&q=chrome');
    expect(annotateBreezeTested).not.toHaveBeenCalled();
  });
});
