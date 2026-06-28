import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

// Auth mock (same pattern as ContractDetail.permissions.test.tsx)
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    contractTransition: vi.fn(),
    generateContractInvoice: vi.fn(),
    getContractEstimate: vi.fn(),
    deleteContract: vi.fn(),
  };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const draftDetail: ContractDetailData = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

const activeDetail: ContractDetailData = {
  ...draftDetail,
  contract: { ...draftDetail.contract, status: 'active' },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'write' }];
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [] } }),
  );
});

describe('ContractDetail — delete action', () => {
  it('shows the Delete draft button for a draft contract when the user has contracts:write', async () => {
    render(<ContractDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.getByTestId('contract-delete-open')).toBeInTheDocument();
  });

  it('hides the Delete draft button on a non-draft contract', async () => {
    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-delete-open')).not.toBeInTheDocument();
  });

  it('hides the Delete draft button when the user lacks contracts:write', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    render(<ContractDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-delete-open')).not.toBeInTheDocument();
  });

  it('deletes a draft contract and navigates to the contracts list', async () => {
    const deleteContract = vi.mocked(contractsApi.deleteContract);
    deleteContract.mockResolvedValue(resp({ data: null }));

    const { navigateTo } = await import('@/lib/navigation');
    const navigateMock = vi.mocked(navigateTo);

    render(<ContractDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-delete-open'));
    await waitFor(() => expect(screen.getByTestId('contract-delete-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-delete-confirm'));
    await waitFor(() => {
      expect(deleteContract).toHaveBeenCalledWith('ct-1');
      expect(navigateMock).toHaveBeenCalledWith('/contracts');
    });
  });
});

describe('ContractDetail — generate invoice action', () => {
  it('gates "Generate invoice now" behind a confirm before billing the client', async () => {
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    const generate = vi.mocked(contractsApi.generateContractInvoice);
    generate.mockResolvedValue(resp({ data: { invoiceId: 'inv-1' } }));

    const { navigateTo } = await import('@/lib/navigation');
    const navigateMock = vi.mocked(navigateTo);

    render(<ContractDetail detail={activeDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    // Clicking the button opens a confirm — it must NOT generate immediately.
    fireEvent.click(screen.getByTestId('generate-now-btn'));
    await waitFor(() => expect(screen.getByTestId('contract-generate-confirm')).toBeInTheDocument());
    expect(generate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('contract-generate-confirm'));
    await waitFor(() => {
      expect(generate).toHaveBeenCalledWith('ct-1');
      expect(navigateMock).toHaveBeenCalledWith('/billing/invoices/inv-1');
    });
  });
});
