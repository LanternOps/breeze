import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { fetchS1Threats, fetchHuntressIncidents } from './edr';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => fetchWithAuth.mockReset());

describe('fetchS1Threats', () => {
  it('passes orgId + deviceId and unwraps pagination shape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 't1' }], pagination: { total: 1, limit: 100, offset: 0 } }));
    const rows = await fetchS1Threats('org-1', 'dev-1');
    expect(rows).toEqual([{ id: 't1' }]);
    const url = fetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/s1/threats');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('deviceId=dev-1');
  });
});

describe('fetchHuntressIncidents', () => {
  it('unwraps the flat (non-pagination) shape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 'i1' }], total: 1, limit: 100, offset: 0 }));
    const rows = await fetchHuntressIncidents('org-1', 'dev-1');
    expect(rows).toEqual([{ id: 'i1' }]);
    expect(fetchWithAuth.mock.calls[0][0]).toContain('/huntress/incidents');
    const url = fetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('deviceId=dev-1');
  });
});
