import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContractDetail from './ContractDetail';
import * as api from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, getContractEstimate: vi.fn(), fetchPeriodOutcome: vi.fn() };
});

const detail: ContractDetailData = {
  contract: {
    id: 'c1', partnerId: 'partner-1', orgId: 'o1', name: 'Managed services', status: 'active',
    billingTiming: 'arrears', intervalMonths: 1, startDate: '2026-01-01', endDate: null,
    nextBillingAt: '2026-09-01', autoIssue: false, autoRenew: false, renewalTermMonths: null,
    renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null, createdBy: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  lines: [],
  periods: [{
    id: 'p1', contractId: 'c1', orgId: 'o1', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    invoiceId: 'inv1', generatedAt: '2026-08-01T00:00:00Z', snapshotDeviceTotal: 40,
    uncoveredTotal: 37, flaggedTotal: 3, billedOverageTotal: 0,
  }],
};

beforeEach(() => {
  vi.mocked(api.getContractEstimate).mockResolvedValue({
    ok: true, json: vi.fn().mockResolvedValue({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] } }),
  } as unknown as Response);
});

describe('ContractDetail period outcome (#3205 W07)', () => {
  it('adds the Outcome column and renders each period summary', async () => {
    render(<ContractDetail detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-periods')).toBeTruthy());
    expect(screen.getByRole('columnheader', { name: 'Outcome' })).toBeTruthy();
    expect(screen.getByTestId('period-outcome-summary-p1')).toHaveTextContent('37');
  });
});
