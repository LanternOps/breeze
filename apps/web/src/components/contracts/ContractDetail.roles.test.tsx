import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';
import { navigateTo } from '@/lib/navigation';

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
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
      taxable: true, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    },
  ],
  periods: [],
};

const roleLine = {
  id: 'cl-2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_role' as const, description: 'Network gear',
  catalogItemId: null, unitPrice: '25.00', manualQuantity: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null,
  siteId: null, site: null, deviceRoles: ['switch', 'firewall'],
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
  taxable: false, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
};

describe('ContractDetail — per_device_role (#3205)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
  });

  it('renders the role list under the line and "auto" as its quantity', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] } }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    const row = await screen.findByTestId('contract-detail-line-cl-2');
    expect(row.textContent).toContain('Switch, Firewall');
    expect(row.textContent).toContain('auto');
  });

  it('shows the coverage warning from the estimate', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: { total: 3, byRole: { printer: 1, unknown: 2 } }, overages: [] },
    }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('contract-coverage-warning')).textContent).toContain('2 Unknown, 1 Printer');
  });

  it('shows an estimate failure banner and no coverage notice for a non-ok response', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({}, false));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);

    expect(await screen.findByTestId('contract-estimate-stale')).toHaveTextContent('Couldn’t load live counts.');
    expect(screen.queryByTestId('contract-coverage-warning')).not.toBeInTheDocument();
  });

  it('shows an estimate failure banner and no coverage notice when the request rejects', async () => {
    (contractsApi.getContractEstimate as any).mockRejectedValue(new Error('network down'));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);

    expect(await screen.findByTestId('contract-estimate-stale')).toHaveTextContent('Couldn’t load live counts.');
    expect(screen.queryByTestId('contract-coverage-warning')).not.toBeInTheDocument();
  });

  it('retries the estimate request from the failure banner', async () => {
    (contractsApi.getContractEstimate as any)
      .mockResolvedValueOnce(resp({}, false))
      .mockResolvedValueOnce(resp({ data: { currencyCode: 'EUR', periodTotal: '25.00', lines: [], uncoveredDevices: null, overages: [] } }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(contractsApi.getContractEstimate).toHaveBeenCalledTimes(2));
  });

  it('generate now warns when the API reports uncovered devices', async () => {
    (contractsApi.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] } }));
    vi.mocked(contractsApi.generateContractInvoice).mockResolvedValue(resp({
      data: { generated: true, invoiceId: 'inv-9', autoIssue: false, priceBookGaps: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } } },
    }));
    render(<ContractDetail detail={{ ...detail, lines: [roleLine] }} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('generate-now-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    const warn = showToast.mock.calls.find((c) => (c[0] as { type: string }).type === 'warning')![0] as { message: string };
    expect(warn.message).toContain('2 Unknown');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-9'));
  });
});
