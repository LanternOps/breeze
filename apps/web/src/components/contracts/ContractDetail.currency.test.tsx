import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData, ContractStatus } from '../../lib/api/contracts';

// Multi-currency wave 6 (#3778), Task 16 — the ACTIVE-contract currency restamp
// action. The server (Task 14) is the authority: it re-checks CONTRACTS_MANAGE,
// the explicit confirmation and eligibility under the contract row lock. These
// tests pin the product half of that contract:
//   - the action is invisible without contracts:manage (and the server still 403s);
//   - it is only offered on an ACTIVE contract (draft keeps today's behaviour);
//   - a 409 renders the blocking row ids the server named, and keeps the dialog
//     open so the operator can act on them — never a bare generic toast;
//   - a success posts EXACTLY the confirmed payload and reloads the contract.

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
    changeContractCurrency: vi.fn(),
  };
});

const resp = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(status: ContractStatus, currencyCode = 'USD'): ContractDetailData {
  return {
    contract: {
      id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status,
      billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
      nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
      currencyCode, notes: null, terms: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    lines: [],
    periods: [],
  };
}

const manage = [{ resource: 'contracts', action: 'manage' }];

async function openDialog() {
  await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('contract-currency-open'));
  await screen.findByTestId('contract-currency-dialog');
}

/** Fill the dialog exactly as a confirming operator would. */
async function confirmWith(mode: 'clear' | 'reprice', currency = 'EUR') {
  fireEvent.change(screen.getByTestId('contract-currency-select'), { target: { value: currency } });
  fireEvent.click(screen.getByTestId(`contract-currency-mode-${mode}`));
  fireEvent.click(screen.getByTestId('contract-currency-confirm-check'));
  fireEvent.click(screen.getByTestId('contract-currency-submit'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = manage;
  (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [] } }),
  );
  (contractsApi.changeContractCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: { id: 'ct-1' } }));
});

describe('ContractDetail — active-contract currency restamp (#3778)', () => {
  it('hides the action without contracts:manage', async () => {
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-currency-open')).not.toBeInTheDocument();
  });

  it('shows the action on an ACTIVE contract with contracts:manage', async () => {
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.getByTestId('contract-currency-open')).toBeInTheDocument();
  });

  it('does not offer the action on a draft contract (draft flow is unchanged)', async () => {
    render(<ContractDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('contract-currency-open')).not.toBeInTheDocument();
  });

  it('never calls the API speculatively when the dialog opens', async () => {
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await openDialog();
    expect(contractsApi.changeContractCurrency).not.toHaveBeenCalled();
  });

  it('keeps submit disabled until a mode is chosen, confirmed, and the currency differs', async () => {
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await openDialog();
    const submit = () => screen.getByTestId('contract-currency-submit') as HTMLButtonElement;

    expect(submit().disabled).toBe(true);                       // nothing chosen
    fireEvent.change(screen.getByTestId('contract-currency-select'), { target: { value: 'EUR' } });
    expect(submit().disabled).toBe(true);                       // no mode
    fireEvent.click(screen.getByTestId('contract-currency-mode-clear'));
    expect(submit().disabled).toBe(true);                       // not confirmed
    fireEvent.click(screen.getByTestId('contract-currency-confirm-check'));
    expect(submit().disabled).toBe(false);

    // Selecting the currency it already carries is not a change.
    fireEvent.change(screen.getByTestId('contract-currency-select'), { target: { value: 'USD' } });
    expect(submit().disabled).toBe(true);
  });

  it('clearLines and reprice are mutually exclusive (the validator refuses both)', async () => {
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await openDialog();
    const clear = screen.getByTestId('contract-currency-mode-clear') as HTMLInputElement;
    const reprice = screen.getByTestId('contract-currency-mode-reprice') as HTMLInputElement;

    fireEvent.click(clear);
    expect(clear.checked).toBe(true);
    expect(reprice.checked).toBe(false);
    fireEvent.click(reprice);
    expect(reprice.checked).toBe(true);
    expect(clear.checked).toBe(false);
  });

  it('posts exactly the confirmed payload and reloads the contract on success', async () => {
    const onChanged = vi.fn();
    render(<ContractDetail detail={detail('active')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('reprice', 'EUR');

    await waitFor(() => expect(contractsApi.changeContractCurrency).toHaveBeenCalledTimes(1));
    expect(contractsApi.changeContractCurrency).toHaveBeenCalledWith('ct-1', {
      currencyCode: 'EUR', reprice: true, confirmActiveChange: true,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('contract-currency-dialog')).not.toBeInTheDocument());
  });

  it('sends clearLines (not reprice) when the operator chooses to clear the lines', async () => {
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear', 'JPY');

    await waitFor(() => expect(contractsApi.changeContractCurrency).toHaveBeenCalledWith('ct-1', {
      currencyCode: 'JPY', clearLines: true, confirmActiveChange: true,
    }));
  });

  it('renders the blocking draft invoice ids from a 409 and keeps the dialog open', async () => {
    (contractsApi.changeContractCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({
      error: 'Contract has unbilled monetary rows',
      code: 'UNBILLED_MONETARY_ROWS',
      details: { draftInvoiceIds: ['inv-a', 'inv-b'] },
    }, 409));

    const onChanged = vi.fn();
    render(<ContractDetail detail={detail('active')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('clear');

    const blockers = await screen.findByTestId('contract-currency-blockers');
    expect(blockers).toBeInTheDocument();
    expect(screen.getByTestId('contract-currency-blocker-inv-a')).toHaveTextContent('inv-a');
    expect(screen.getByTestId('contract-currency-blocker-inv-b')).toHaveTextContent('inv-b');
    // The remedy is named, not a bare token.
    expect(blockers.textContent).toMatch(/draft invoice/i);
    // Still open, nothing reloaded — the operator has work to do first.
    expect(screen.getByTestId('contract-currency-dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('renders the offending ids for every 409 blocker code, not just draft invoices', async () => {
    const cases = [
      { code: 'ORPHANED_BILLING_PERIOD', details: { billingPeriodIds: ['bp-1'] }, id: 'bp-1' },
      { code: 'ORPHANED_CONTRACT_SOURCE', details: { lineIds: ['il-1'] }, id: 'il-1' },
      { code: 'BROKEN_CONTRACT_LINEAGE', details: { invoiceIds: ['inv-x'] }, id: 'inv-x' },
    ];
    for (const kase of cases) {
      vi.clearAllMocks();
      (contractsApi.getContractEstimate as ReturnType<typeof vi.fn>).mockResolvedValue(
        resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [] } }),
      );
      (contractsApi.changeContractCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(
        resp({ error: kase.code, code: kase.code, details: kase.details }, 409),
      );
      const view = render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
      await openDialog();
      await confirmWith('clear');
      expect(await screen.findByTestId(`contract-currency-blocker-${kase.id}`)).toHaveTextContent(kase.id);
      view.unmount();
    }
  });

  it('clears a previous blocker list when the operator retries', async () => {
    (contractsApi.changeContractCurrency as ReturnType<typeof vi.fn>).mockResolvedValueOnce(resp({
      error: 'blocked', code: 'UNBILLED_MONETARY_ROWS', details: { draftInvoiceIds: ['inv-a'] },
    }, 409));
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear');
    await screen.findByTestId('contract-currency-blockers');

    (contractsApi.changeContractCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: { id: 'ct-1' } }));
    fireEvent.click(screen.getByTestId('contract-currency-submit'));
    await waitFor(() => expect(screen.queryByTestId('contract-currency-dialog')).not.toBeInTheDocument());
  });
});
