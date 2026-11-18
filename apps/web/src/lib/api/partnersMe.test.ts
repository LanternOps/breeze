import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));

import { getPartnersMe, invalidatePartnersMe } from './partnersMe';

const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePartnersMe();
});

describe('getPartnersMe', () => {
  it('concurrent callers on one page load share one GET /orgs/partners/me', async () => {
    let release!: (r: Response) => void;
    fetchWithAuth.mockImplementation(() => new Promise<Response>(r => { release = r; }));
    const reads = [getPartnersMe(), getPartnersMe(), getPartnersMe()];
    release(json({ id: 'p-1', name: 'Acme' }));
    const results = await Promise.all(reads);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me');
    for (const r of results) expect(r).toEqual({ ok: true, status: 200, data: { id: 'p-1', name: 'Acme' } });
  });

  it('nothing is cached once the read settles: the next caller refetches', async () => {
    fetchWithAuth.mockResolvedValue(json({ id: 'p-1' }));
    await getPartnersMe();
    await getPartnersMe();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('invalidate makes the next caller start its own read even while one is in flight', async () => {
    fetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
    void getPartnersMe();
    invalidatePartnersMe();
    void getPartnersMe();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a failed status is shared without a body', async () => {
    fetchWithAuth.mockResolvedValue(json({ error: 'no' }, 403));
    const [a, b] = await Promise.all([getPartnersMe(), getPartnersMe()]);
    expect(a).toEqual({ ok: false, status: 403, data: null });
    expect(b).toBe(a);
  });

  it('a network error rejects every sharer and clears the slot', async () => {
    fetchWithAuth.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(json({ id: 'p-1' }));
    await expect(Promise.all([getPartnersMe(), getPartnersMe()])).rejects.toThrow('offline');
    expect((await getPartnersMe()).ok).toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });
});
