import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: {
    getState: () => ({ fetchOrganizations: vi.fn() }),
  },
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/apiError', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'error'),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const ORG_A = { id: 'org-a-uuid', name: 'Org A', status: 'active', slug: 'org-a', deviceCount: 0 };
const ORG_B = { id: 'org-b-uuid', name: 'Org B', status: 'active', slug: 'org-b', deviceCount: 0 };

describe('OrganizationsPage — fetchSites URL contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url) => {
      if (url === '/orgs/organizations') {
        return jsonResponse({ data: [ORG_A, ORG_B] });
      }
      if (typeof url === 'string' && url.startsWith('/orgs/sites?')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({});
    });
  });

  it('passes orgId= (not organizationId=) so fetchWithAuth auto-injection cannot double-set it', async () => {
    render(<OrganizationsPage />);
    await screen.findByTestId(`org-row-${ORG_B.id}`);
    fireEvent.click(screen.getByTestId(`org-row-${ORG_B.id}`));

    await waitFor(() => {
      const sitesCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/orgs/sites?'),
      );
      expect(sitesCalls.length).toBeGreaterThan(0);
      const url = sitesCalls[sitesCalls.length - 1][0] as string;
      expect(url).toContain(`orgId=${ORG_B.id}`);
      expect(url).not.toContain(`organizationId=`);
    });
  });
});
