import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// The sibling tabs are not under test here — stub them so mounting the shell
// doesn't drag their own fetch graphs in.
vi.mock('./ContractsList', () => ({ ContractsList: () => <div data-testid="stub-contracts-list" /> }));
vi.mock('./TemplatesTab', () => ({ default: () => <div data-testid="stub-templates-tab" /> }));
vi.mock('./DocumentsTab', () => ({ default: () => <div data-testid="stub-documents-tab" /> }));

const contractsApi = vi.hoisted(() => ({ listContractCurrencyMismatches: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, ...contractsApi };
});

import ContractsTabs from './ContractsTabs';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ELIGIBLE = {
  contractId: 'ct-eligible', contractName: 'Legacy MSA', orgId: 'org-1', orgName: 'Acme',
  status: 'active' as const, contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR',
  nextBillingAt: '2026-09-01T00:00:00Z',
  draftMonetaryInvoiceCount: 0, blockingDraftInvoiceIds: [],
  orphanedBillingPeriodCount: 0, activeChangeEligible: true, ineligibleReason: null,
};
const BLOCKED = {
  ...ELIGIBLE, contractId: 'ct-blocked', contractName: 'Billed MSA',
  draftMonetaryInvoiceCount: 2, blockingDraftInvoiceIds: ['inv-1', 'inv-2'],
  activeChangeEligible: false, ineligibleReason: 'UNBILLED_MONETARY_ROWS' as const,
};
const CANCELLED = {
  ...ELIGIBLE, contractId: 'ct-cancelled', contractName: 'Old MSA', status: 'cancelled' as const,
  activeChangeEligible: false, ineligibleReason: 'STATUS_NOT_ACTIVE' as const,
};

async function openTab() {
  render(<ContractsTabs />);
  fireEvent.click(screen.getByTestId('contracts-tab-currency-mismatches'));
  await screen.findByTestId('currency-mismatches-tab');
}

describe('ContractsTabs — currency mismatch report tab (#3778)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    contractsApi.listContractCurrencyMismatches.mockResolvedValue(
      resp({ data: { items: [ELIGIBLE, BLOCKED, CANCELLED], nextCursor: null } })
    );
  });

  it('defaults to the contracts list and only mounts the report when selected', async () => {
    render(<ContractsTabs />);
    expect(screen.getByTestId('stub-contracts-list')).toBeTruthy();
    expect(screen.queryByTestId('currency-mismatches-tab')).toBeNull();
    expect(contractsApi.listContractCurrencyMismatches).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('contracts-tab-currency-mismatches'));
    await screen.findByTestId('currency-mismatches-tab');
    expect(window.location.hash).toContain('tab=currency-mismatches');
    expect(screen.queryByTestId('stub-contracts-list')).toBeNull();
  });

  it('renders one row per mismatch with both currencies and the server verdict', async () => {
    await openTab();

    await screen.findByTestId('currency-mismatch-row-ct-eligible');
    expect(screen.getByTestId('currency-mismatch-currencies-ct-eligible').textContent).toContain('USD');
    expect(screen.getByTestId('currency-mismatch-currencies-ct-eligible').textContent).toContain('EUR');
    expect(screen.getByTestId('currency-mismatch-eligibility-ct-eligible').textContent)
      .toBe('Ready to restamp');

    // The report never re-derives eligibility: the blocked row shows the exact
    // reason the mutation would throw, plus its blocking draft count.
    const blocked = screen.getByTestId('currency-mismatch-eligibility-ct-blocked').textContent ?? '';
    expect(blocked).toContain('Draft invoices still hold money');
    expect(blocked).toContain('2 draft invoices');

    expect(screen.getByTestId('currency-mismatch-eligibility-ct-cancelled').textContent)
      .toContain('Not active');

    // Every row links to the contract detail page — a route that exists today.
    expect(screen.getByTestId('currency-mismatch-link-ct-eligible').getAttribute('href'))
      .toBe('/contracts/ct-eligible');
  });

  it('is read-only: no bulk action of any kind is rendered', async () => {
    await openTab();
    await screen.findByTestId('currency-mismatch-row-ct-eligible');

    expect(screen.queryByTestId('currency-mismatches-bulk')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // The only button on the tab is pagination, and there is none for one page.
    expect(screen.queryByTestId('currency-mismatches-load-more')).toBeNull();
  });

  it('pages with the server cursor and appends, never replaces', async () => {
    contractsApi.listContractCurrencyMismatches
      .mockResolvedValueOnce(resp({ data: { items: [ELIGIBLE], nextCursor: 'ct-eligible' } }))
      .mockResolvedValueOnce(resp({ data: { items: [BLOCKED], nextCursor: null } }));

    await openTab();
    await screen.findByTestId('currency-mismatch-row-ct-eligible');

    fireEvent.click(screen.getByTestId('currency-mismatches-load-more'));
    await screen.findByTestId('currency-mismatch-row-ct-blocked');
    expect(screen.getByTestId('currency-mismatch-row-ct-eligible')).toBeTruthy();
    expect(contractsApi.listContractCurrencyMismatches.mock.calls[1][0])
      .toMatchObject({ cursor: 'ct-eligible' });
    await waitFor(() => expect(screen.queryByTestId('currency-mismatches-load-more')).toBeNull());
  });

  it('renders an empty state when nothing is mismatched', async () => {
    contractsApi.listContractCurrencyMismatches.mockResolvedValue(
      resp({ data: { items: [], nextCursor: null } })
    );
    await openTab();
    await screen.findByTestId('currency-mismatches-empty');
  });

  it('surfaces a load failure instead of rendering an empty report', async () => {
    contractsApi.listContractCurrencyMismatches.mockResolvedValue(resp({ error: 'nope' }, 500));
    await openTab();
    await screen.findByTestId('currency-mismatches-error');
    expect(screen.queryByTestId('currency-mismatches-empty')).toBeTruthy();
  });
});
