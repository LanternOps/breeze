import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData, ContractStatus } from '../../lib/api/contracts';

// Cancel is terminal (stops all future invoicing, no transition out), so the
// detail page now gates it behind a confirm dialog while reversible transitions
// (pause/resume) still fire immediately. These tests pin that contract — a
// regression here could cancel a live contract on a single misclick.

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
  };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(status: ContractStatus): ContractDetailData {
  return {
    contract: {
      id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status,
      billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
      nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
      currencyCode: 'USD', notes: null, terms: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    lines: [
      {
        id: 'cl-1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Managed services',
        catalogItemId: null, unitPrice: '500.00', manualQuantity: null, siteId: null, taxable: false,
        sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
      },
    ],
    periods: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // cancel/pause are manage-gated; grant it so the lifecycle buttons render.
  state.permissions = [{ resource: 'contracts', action: 'manage' }];
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [] } }),
  );
  (contractsApi.contractTransition as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: null }));
});

describe('ContractDetail — cancel confirmation', () => {
  it('clicking Cancel opens a confirm dialog and does NOT transition immediately', async () => {
    const contractTransition = vi.mocked(contractsApi.contractTransition);
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-cancel-btn'));

    // The confirm appears...
    await waitFor(() => expect(screen.getByTestId('contract-cancel-confirm')).toBeInTheDocument());
    // ...and nothing was cancelled yet. This is the misclick guardrail.
    expect(contractTransition).not.toHaveBeenCalled();
  });

  it('confirming the dialog cancels the contract', async () => {
    const contractTransition = vi.mocked(contractsApi.contractTransition);
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-cancel-btn'));
    fireEvent.click(await screen.findByTestId('contract-cancel-confirm'));

    await waitFor(() => expect(contractTransition).toHaveBeenCalledWith('ct-1', 'cancel'));
  });

  it('dismissing the dialog leaves the contract untouched', async () => {
    const contractTransition = vi.mocked(contractsApi.contractTransition);
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-cancel-btn'));
    const dialog = await screen.findByRole('dialog');
    // The dialog's own dismiss button is named exactly "Cancel" (the confirm is
    // "Cancel contract"), so scope to the dialog and match the exact name.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(contractTransition).not.toHaveBeenCalled();
  });

  it('Pause is reversible, so it fires immediately without a confirm dialog', async () => {
    const contractTransition = vi.mocked(contractsApi.contractTransition);
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('contract-pause-btn'));

    await waitFor(() => expect(contractTransition).toHaveBeenCalledWith('ct-1', 'pause'));
    // No confirm gate for a reversible action.
    expect(screen.queryByTestId('contract-cancel-confirm')).not.toBeInTheDocument();
  });
});
