import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData, ContractEstimate } from '../../lib/api/contracts';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
      selector({ user: { permissions: [] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, getContractEstimate: vi.fn() };
});

const resp = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const detail: ContractDetailData = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: '2026-07-01', autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

const groupLine = {
  id: 'cl-live', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_group' as const,
  description: 'Managed group', catalogItemId: null, unitPrice: '12.00', manualQuantity: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null,
  siteId: null, site: null, deviceRoles: null, deviceGroupId: 'group-1', deviceGroupName: 'Live Servers',
  deviceGroup: { id: 'group-1', name: 'Live Servers', type: 'dynamic' as const },
  taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const estimate = (lines: ContractEstimate['lines'] = []): ContractEstimate => ({
  currencyCode: 'USD', periodTotal: '0.00', lines, uncoveredDevices: null, overages: [],
});

describe('ContractDetail — per_device_group (#3205)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a live group name and its dynamic label', async () => {
    vi.mocked(contractsApi.getContractEstimate).mockResolvedValue(resp({ data: estimate() }));
    render(<ContractDetail detail={{ ...detail, lines: [groupLine] }} onChanged={vi.fn()} />);

    expect(await screen.findByTestId('contract-detail-line-group-cl-live')).toHaveTextContent('Live Servers · dynamic');
  });

  it('renders the stamped name and deleted label for a deleted group', async () => {
    vi.mocked(contractsApi.getContractEstimate).mockResolvedValue(resp({ data: estimate() }));
    const deletedLine = { ...groupLine, id: 'cl-deleted', deviceGroup: null, deviceGroupName: 'Legacy Servers' };
    render(<ContractDetail detail={{ ...detail, lines: [deletedLine] }} onChanged={vi.fn()} />);

    expect(await screen.findByTestId('contract-detail-line-group-cl-deleted')).toHaveTextContent('Legacy Servers (deleted group)');
  });

  it('renders group deleted in the quantity cell for an unresolved estimate line', async () => {
    vi.mocked(contractsApi.getContractEstimate).mockResolvedValue(resp({
      data: estimate([{
        lineId: 'cl-live', lineType: 'per_device_group', quantity: 0, counted: 0, included: null,
        overage: 0, overageMode: null, overageValue: '0.00', value: '0.00', live: true, unresolved: 'group_deleted',
      }]),
    }));
    render(<ContractDetail detail={{ ...detail, lines: [groupLine] }} onChanged={vi.fn()} />);

    const row = await screen.findByTestId('contract-detail-line-cl-live');
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('group deleted');
  });
});
