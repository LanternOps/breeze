import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as api from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

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
  return { ...actual, contractTransition: vi.fn(), generateContractInvoice: vi.fn(), getContractEstimate: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const detail: ContractDetailData = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: '2026-07-01', autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null, createdBy: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

describe('ContractDetail — allowance block (#3205 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] },
    }));
  });

  function renderDetail(lines: ContractDetailData['lines'] = []) {
    return render(<ContractDetail detail={{ ...detail, lines }} onChanged={vi.fn()} />);
  }

  it('raises a warning toast for FLAGGED overage on generate, and none for billed', async () => {
    (api.generateContractInvoice as any).mockResolvedValue(resp({ data: {
      generated: true, invoiceId: 'inv-1', priceBookGaps: [], uncoveredDevices: null,
      overages: [
        { contractLineId: 'l1', invoiceLineId: null, description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' },
        { contractLineId: 'l2', invoiceLineId: 'il2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
      ],
    } }));
    renderDetail();
    fireEvent.click(await screen.findByTestId('generate-now-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    const warnings = vi.mocked(showToast).mock.calls.filter(([a]) => (a as { type: string }).type === 'warning');
    expect(warnings).toHaveLength(1);
    expect((warnings[0]![0] as { message: string }).message).toContain('Endpoints');
    expect((warnings[0]![0] as { message: string }).message).not.toContain('Servers');
  });

  it('renders the allowance in the quantity cell and the digest under the estimate stat', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: {
      currencyCode: 'USD', periodTotal: '262.00', uncoveredDevices: null,
      lines: [{
        lineId: 'l1', lineType: 'per_device', quantity: 25, value: '250.00', live: true,
        counted: 26, included: 25, overage: 1, overageMode: 'bill', overageValue: '12.00',
      }],
      overages: [{ contractLineId: 'l1', invoiceLineId: 'il1', description: 'Endpoints', counted: 26, included: 25, overage: 1, mode: 'bill' }],
    } }));
    renderDetail([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Endpoints',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null,
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
      taxable: true, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    const cell = await screen.findByTestId('contract-detail-line-qty-l1');
    expect(cell.querySelector('[data-testid="allowance-over-billed"]')).not.toBeNull();
    expect(cell.textContent).toMatch(/25.*1/);
    expect(await screen.findByTestId('contract-overage-billed')).toHaveTextContent('Endpoints');
    expect(screen.queryByTestId('contract-overage-flagged')).toBeNull();
  });
});
