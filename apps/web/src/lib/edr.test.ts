import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { fetchS1Threats, fetchHuntressIncidents } from './edr';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => fetchWithAuth.mockReset());

describe('fetchS1Threats', () => {
  it('passes filters and returns { rows, total } from the pagination shape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 't1' }], pagination: { total: 5, limit: 100, offset: 0 } }));
    const { rows, total } = await fetchS1Threats({ orgId: 'org-1', deviceId: 'dev-1' });
    expect(rows).toEqual([{ id: 't1' }]);
    expect(total).toBe(5);
    const url = fetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/s1/threats');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('deviceId=dev-1');
  });
});

describe('fetchHuntressIncidents', () => {
  it('reads { rows, total } from the Huntress flat shape and omits empty filters', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 'i1' }], total: 3, limit: 100, offset: 0 }));
    const { rows, total } = await fetchHuntressIncidents({ severity: 'high' });
    expect(rows).toEqual([{ id: 'i1' }]);
    expect(total).toBe(3);
    const url = fetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/huntress/incidents');
    expect(url).toContain('severity=high');
    expect(url).not.toContain('orgId=');
  });
});
