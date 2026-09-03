import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';
import { navigateTo } from '@/lib/navigation';

// Post-merge review #10 (multi-currency wave 3, #3775): a catalog line with no
// price in the contract's currency is still billed — at the contract line's
// stamped snapshot — and the generate route reports it as `priceBookGaps`. The
// manual "Generate now" UI must surface that to the operator instead of a bare
// success toast; the permitted fallback is never silent.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    contractTransition: vi.fn(),
    generateContractInvoice: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const detail: ContractDetailData = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: '2026-07-01', autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'EUR', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [
    {
      id: 'cl-1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Managed endpoint',
      catalogItemId: 'cat-1', unitPrice: '80.00', manualQuantity: null,
      includedQuantity: null, overageMode: null, overageUnitPrice: null,
      siteId: null, site: null, deviceRoles: null,
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null, taxable: true,
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    },
  ],
  periods: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'manage' }];
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'EUR', periodTotal: '80.00', lines: [], uncoveredDevices: null, overages: [] } }),
  );
});

describe('ContractDetail — generate now surfaces price-book gaps', () => {
  it('warns with the affected lines + currency when the API reports priceBookGaps, then navigates', async () => {
    vi.mocked(contractsApi.generateContractInvoice).mockResolvedValue(resp({
      data: {
        generated: true, invoiceId: 'inv-1', autoIssue: false,
        priceBookGaps: [
          { contractLineId: 'cl-1', catalogItemId: 'cat-1', itemName: 'Managed endpoint', currencyCode: 'EUR' },
          { contractLineId: 'cl-2', catalogItemId: 'cat-2', itemName: 'Backup', currencyCode: 'EUR' },
        ],
      },
    }));
    render(<ContractDetail detail={detail} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('generate-now-btn'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    const warning = showToast.mock.calls.map((c) => c[0] as { type: string; message: string }).find((a) => a.type === 'warning')!;
    expect(warning.message).toContain('2 catalog line(s)');
    expect(warning.message).toContain('EUR');
    expect(warning.message).toContain('Managed endpoint');
    expect(warning.message).toContain('Backup');
    expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1');
  });

  it('shows only the success toast (no warning) when priceBookGaps is empty', async () => {
    vi.mocked(contractsApi.generateContractInvoice).mockResolvedValue(resp({
      data: { generated: true, invoiceId: 'inv-1', autoIssue: false, priceBookGaps: [] },
    }));
    render(<ContractDetail detail={detail} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('generate-now-btn'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1'));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
