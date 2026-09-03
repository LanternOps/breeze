import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeout = vi.fn();
const refreshAccessToken = vi.fn();
vi.mock('./fetchWithTimeout', () => ({ fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a) }));
vi.mock('./api', () => ({ refreshAccessToken: () => refreshAccessToken() }));

import { fetchWithAuthRefresh } from './authedFetch';

const res = (status: number) => ({ status, ok: status < 300 }) as Response;
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

beforeEach(() => { fetchWithTimeout.mockReset(); refreshAccessToken.mockReset(); });

describe('fetchWithAuthRefresh', () => {
  it('passes a non-401 response through untouched and never refreshes', async () => {
    fetchWithTimeout.mockResolvedValueOnce(res(200));
    const r = await fetchWithAuthRefresh('https://x/api/v1/systems', auth('t1'), 5000);
    expect(r.status).toBe(200);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchWithTimeout).toHaveBeenCalledWith('https://x/api/v1/systems', auth('t1'), 5000);
  });

  it('on 401 refreshes once and replays with the new bearer, keeping every other header', async () => {
    fetchWithTimeout.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200));
    refreshAccessToken.mockResolvedValueOnce('t2');
    const r = await fetchWithAuthRefresh('https://x/api/v1/systems', { ...auth('t1'), method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect(fetchWithTimeout.mock.calls[1][1]).toEqual({
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer t2', Accept: 'application/json' },
    });
  });

  it('returns the original 401 when the refresh fails, with no retry', async () => {
    fetchWithTimeout.mockResolvedValueOnce(res(401));
    refreshAccessToken.mockResolvedValueOnce(null);
    const r = await fetchWithAuthRefresh('https://x/api/v1/systems', auth('t1'));
    expect(r.status).toBe(401);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries at most once: a second 401 is returned as-is', async () => {
    fetchWithTimeout.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(401));
    refreshAccessToken.mockResolvedValueOnce('t2');
    const r = await fetchWithAuthRefresh('https://x/api/v1/systems', auth('t1'));
    expect(r.status).toBe(401);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when the request carried no bearer, or when opted out', async () => {
    fetchWithTimeout.mockResolvedValue(res(401));
    await fetchWithAuthRefresh('https://x/api/v1/systems', { headers: { Accept: 'application/json' } });
    await fetchWithAuthRefresh('https://x/api/v1/approvals/1/approve', auth('t1'), undefined, { retryOnAuthFailure: false });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});
