import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BaselineApplyTab from './BaselineApplyTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (state: { currentOrgId: string }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown): Response => ({
  ok: true,
  status: 200,
  json: vi.fn().mockResolvedValue(payload),
}) as unknown as Response;

describe('BaselineApplyTab device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/devices/options?')) return response({
        data: [{ id: 'device-1', hostname: 'zzz-baseline-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
      });
      if (url.startsWith('/audit-baselines/apply-requests?')) return response({ data: [] });
      return response({ data: [] });
    });
  });

  it('loads an org- and OS-scoped server option page without using the general devices reader', async () => {
    render(<BaselineApplyTab baseline={{
      id: 'baseline-1', orgId: 'org-1', name: 'Linux baseline', osType: 'linux',
      profile: 'cis_l1', settings: {}, isActive: true, createdBy: null,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    }} />);

    expect(await screen.findByText('zzz-baseline-device')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = String(input);
      return url.startsWith('/devices/options?') && url.includes('orgId=org-1') && url.includes('osType=linux');
    })).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => /^\/devices(?:\?|$)/.test(String(input)))).toBe(false);
  });
});
