import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));

import { fetchFieldOrgs, fetchTabInheritance } from './partnerSettingsInheritance';

const res = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fetchTabInheritance', () => {
  it('reads the tab without the ambient orgId', async () => {
    const data = { tab: 'defaults', orgCount: 4, fields: [] };
    fetchWithAuth.mockResolvedValue(res({ data }));
    await expect(fetchTabInheritance('defaults')).resolves.toEqual({ status: 'ok', data });
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me/settings-inheritance?tab=defaults', { skipOrgIdInjection: true });
  });

  it('403 PARTNER_WIDE_REQUIRED is restricted, without a warning', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'x', code: 'PARTNER_WIDE_REQUIRED' }, 403));
    await expect(fetchTabInheritance('security')).resolves.toEqual({ status: 'restricted' });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('any other failure is unavailable and only logged', async () => {
    fetchWithAuth.mockResolvedValueOnce(res({ error: 'nope' }, 403));
    await expect(fetchTabInheritance('security')).resolves.toEqual({ status: 'unavailable' });
    fetchWithAuth.mockResolvedValueOnce(res({ error: 'boom' }, 500));
    await expect(fetchTabInheritance('security')).resolves.toEqual({ status: 'unavailable' });
    fetchWithAuth.mockRejectedValueOnce(new TypeError('network'));
    await expect(fetchTabInheritance('security')).resolves.toEqual({ status: 'unavailable' });
    fetchWithAuth.mockResolvedValueOnce(res({ data: { tab: 'security' } }));
    await expect(fetchTabInheritance('security')).resolves.toEqual({ status: 'unavailable' });
    expect(console.warn).toHaveBeenCalledTimes(4);
  });
});

describe('fetchFieldOrgs', () => {
  it('passes field, bucket and cursor', async () => {
    const page = { field: 'security.requireMfa', rows: [], nextCursor: null };
    fetchWithAuth.mockResolvedValue(res({ data: page }));
    await expect(fetchFieldOrgs('security.requireMfa', 'abc_-', 'shadowed')).resolves.toEqual(page);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/orgs/partners/me/settings-inheritance/orgs?field=security.requireMfa&bucket=shadowed&cursor=abc_-',
      { skipOrgIdInjection: true },
    );
  });

  it('defaults to the ownValue bucket and omits an empty cursor', async () => {
    fetchWithAuth.mockResolvedValue(res({ data: { field: 'eventLogs', rows: [], nextCursor: null } }));
    await fetchFieldOrgs('eventLogs', null);
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me/settings-inheritance/orgs?field=eventLogs&bucket=ownValue', { skipOrgIdInjection: true });
  });

  it('throws on failure so the drill-down can offer a retry', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'bad' }, 400));
    await expect(fetchFieldOrgs('eventLogs', null)).rejects.toThrow('inheritance_orgs_failed_400');
  });
});
