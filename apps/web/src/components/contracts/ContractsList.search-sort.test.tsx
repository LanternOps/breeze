import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// Mock fetchWithAuth — called directly for loadOrgs.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

const listContracts = vi.fn();
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, listContracts: (...a: unknown[]) => listContracts(...a) };
});

import { ContractsList } from './ContractsList';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = {
  partnerId: 'p1',
  billingTiming: 'advance' as const,
  currencyCode: 'USD',
  endDate: null,
  autoIssue: false,
  autoRenew: false,
  renewalTermMonths: null,
  renewalNoticeDays: null,
  createdBy: null,
  notes: null,
  terms: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const ALPHA = {
  ...base,
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  orgId: 'o1',
  name: 'Alpha Retainer',
  status: 'active' as const,
  intervalMonths: 1,
  nextBillingAt: '2026-02-01',
  startDate: '2026-01-01',
  estimatedPeriodValue: '100.00',
};

const ZETA = {
  ...base,
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  orgId: 'o2',
  name: 'Zeta Support',
  status: 'active' as const,
  intervalMonths: 3,
  nextBillingAt: '2026-03-01',
  startDate: '2026-02-01',
  estimatedPeriodValue: '900.00',
};

const ORGS = [
  { id: 'o1', name: 'Acme Corp' },
  { id: 'o2', name: 'Globex' },
];

describe('ContractsList — search, sort & skeleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchWithAuth.mockResolvedValue(json({ data: ORGS }));
  });

  it('renders a skeleton (not a spinner) while loading', async () => {
    // Never-resolving load keeps the component in the loading state.
    listContracts.mockReturnValue(new Promise(() => {}));
    render(<ContractsList />);

    expect(await screen.findByTestId('table-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('contracts-loading')).not.toBeInTheDocument();
  });

  it('filters rows by contract name via the search box', async () => {
    listContracts.mockResolvedValue(json({ data: [ALPHA, ZETA] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-list');
    expect(screen.getByTestId(`contract-row-${ALPHA.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`contract-row-${ZETA.id}`)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('contracts-search'), { target: { value: 'zeta' } });

    await waitFor(() => {
      expect(screen.queryByTestId(`contract-row-${ALPHA.id}`)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId(`contract-row-${ZETA.id}`)).toBeInTheDocument();
  });

  it('filters rows by organization name via the search box', async () => {
    listContracts.mockResolvedValue(json({ data: [ALPHA, ZETA] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-list');
    fireEvent.change(screen.getByTestId('contracts-search'), { target: { value: 'globex' } });

    await waitFor(() => {
      expect(screen.queryByTestId(`contract-row-${ALPHA.id}`)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId(`contract-row-${ZETA.id}`)).toBeInTheDocument();
  });

  it('sorts by name when the Name header is clicked', async () => {
    listContracts.mockResolvedValue(json({ data: [ZETA, ALPHA] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-list');
    fireEvent.click(screen.getByTestId('contracts-sort-name'));

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^contract-row-/);
      // asc → Alpha before Zeta
      expect(rows[0]).toHaveAttribute('data-testid', `contract-row-${ALPHA.id}`);
      expect(rows[1]).toHaveAttribute('data-testid', `contract-row-${ZETA.id}`);
    });

    // Toggle to descending → Zeta first.
    fireEvent.click(screen.getByTestId('contracts-sort-name'));
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^contract-row-/);
      expect(rows[0]).toHaveAttribute('data-testid', `contract-row-${ZETA.id}`);
    });
  });

  it('marks the active sort header with aria-sort', async () => {
    listContracts.mockResolvedValue(json({ data: [ALPHA, ZETA] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-list');
    const nameHeader = screen.getByTestId('contracts-sort-name').closest('th')!;
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(screen.getByTestId('contracts-sort-name'));
    await waitFor(() => {
      expect(screen.getByTestId('contracts-sort-name').closest('th')).toHaveAttribute('aria-sort', 'ascending');
    });
  });
});
