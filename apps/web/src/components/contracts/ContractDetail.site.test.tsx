import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData, ContractLine } from '../../lib/api/contracts';
import { fetchWithAuth } from '../../stores/auth';

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

const fetchMock = vi.mocked(fetchWithAuth);
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

const renderDetail = (lines: ContractLine[]) => {
  vi.mocked(contractsApi.getContractEstimate).mockResolvedValue(resp({
    data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null },
  }));
  return render(<ContractDetail detail={{ ...detail, lines }} onChanged={vi.fn()} />);
};

describe('ContractDetail — line site sub-label (#3205 W03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders only present line.site names and issues no /sites request', async () => {
    renderDetail([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Managed device',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: 'site-1',
      site: { id: 'site-1', name: 'HQ' }, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
      deviceGroup: null, taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }, {
      id: 'l2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Org-wide device',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, site: null,
      deviceRoles: null, deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
      taxable: false, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
    }]);
    expect((await screen.findByTestId('contract-detail-line-site-l1')).textContent).toBe('Site: HQ');
    expect(screen.getByTestId('contract-detail-line-l2')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-detail-line-site-l2')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/orgs/sites'))).toBe(false);
  });
});
