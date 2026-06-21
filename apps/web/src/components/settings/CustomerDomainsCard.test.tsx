import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: { request: () => Promise<Response> }) => {
    const r = await o.request();
    return r.json().catch(() => null);
  },
  handleActionError: vi.fn(),
}));

import { CustomerDomainsCard } from './CustomerDomainsCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('CustomerDomainsCard', () => {
  it('lists existing domain mappings', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ticket-config/inbound-domains') {
        return Promise.resolve(
          jsonRes({
            data: [
              {
                id: '1',
                domain: 'acme.com',
                orgId: 'o-1',
                orgName: 'ACME',
                autoCreateContact: true,
                isActive: true,
              },
            ],
          }),
        );
      }
      if (url === '/orgs/organizations?limit=100') {
        return Promise.resolve(jsonRes({ data: [{ id: 'o-1', name: 'ACME' }] }));
      }
      return Promise.resolve(jsonRes({ data: [] }));
    });

    render(<CustomerDomainsCard />);

    await waitFor(() => expect(screen.getByText('acme.com')).toBeInTheDocument());
    expect(within(screen.getByTestId('customer-domain-row-1')).getByText('ACME')).toBeInTheDocument();
  });
});
