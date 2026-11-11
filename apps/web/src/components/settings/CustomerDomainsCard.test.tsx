import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

import { CustomerDomainsCard } from './CustomerDomainsCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const ROWS = [
  {
    id: '1', domain: 'acme.com', orgId: 'o-1', orgName: 'ACME', autoCreateContact: true, isActive: true,
    state: 'verified', method: 'dns_txt',
  },
  {
    id: '2', domain: 'acme.co.uk', orgId: 'o-1', orgName: 'ACME', autoCreateContact: false, isActive: true,
    state: 'declared', method: null,
  },
  // An API build before W05a sends no verification fields: the row reads as declared.
  { id: '3', domain: 'globex.com', orgId: 'o-2', orgName: 'Globex', autoCreateContact: true, isActive: false },
];

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
});

describe('CustomerDomainsCard (read-only summary)', () => {
  it('lists every mapping with its organization and state', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: ROWS }));
    render(<CustomerDomainsCard />);
    const row1 = await screen.findByTestId('customer-domain-row-1');
    expect(within(row1).getByText('acme.com')).toBeInTheDocument();
    expect(within(row1).getByText('ACME')).toBeInTheDocument();
    expect(within(row1).getByTestId('customer-domain-state-1')).toHaveTextContent(/verified · DNS/i);
    expect(screen.getByTestId('customer-domain-state-2')).toHaveTextContent(/declared — mail routing only/i);
    expect(screen.getByTestId('customer-domain-state-3')).toHaveTextContent(/declared — mail routing only/i);
    expect(screen.getByTestId('customer-domains-managed-per-org')).toHaveTextContent(/managed per organization/i);
  });

  it('CustomerDomainsCard renders no add, edit or delete controls', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: ROWS }));
    render(<CustomerDomainsCard />);
    await screen.findByTestId('customer-domain-row-1');
    const card = screen.getByTestId('customer-domains-card');
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(within(card).queryByRole('checkbox')).toBeNull();
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(within(card).queryByRole('button')).toBeNull();
    // Only the list read; never the org picker or a write.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-config/inbound-domains');
  });

  it("each summary row links to the org's #domains tab", async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: ROWS }));
    render(<CustomerDomainsCard />);
    const row = await screen.findByTestId('customer-domain-row-3');
    expect(within(row).getByTestId('customer-domain-manage-3').getAttribute('href')).toBe('/settings/organizations/o-2#domains');
  });

  it('a load failure offers a retry', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'boom' }, false, 500));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: ROWS }));
    render(<CustomerDomainsCard />);
    fireEvent.click(await screen.findByTestId('customer-domains-retry'));
    await waitFor(() => expect(screen.getByTestId('customer-domain-row-1')).toBeInTheDocument());
  });

  it('a malformed body lands in the error state, not an empty list', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: { not: 'an array' } }));
    render(<CustomerDomainsCard />);
    expect(await screen.findByTestId('customer-domains-error')).toBeInTheDocument();
  });
});
