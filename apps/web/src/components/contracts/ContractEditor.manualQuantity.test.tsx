import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import type { ContractLine } from '../../lib/api/contracts';
import { showToast } from '../shared/Toast';

// #10293: a manual line with a cleared Quantity reached the API and toasted the
// raw Zod text "Manual quantity: must be a 2-decimal money string". The form now
// checks the shared grammar inline and maps a server field error onto the field.

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  resolveCatalogPrice: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(),
    removeContractLine: vi.fn(), updateContractLine: vi.fn(), contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  autopayExcluded: false,
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const manualLine: ContractLine = {
  id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'manual', description: 'Licenses',
  catalogItemId: null, unitPrice: '10.00', manualQuantity: '3.00',
  includedQuantity: null, overageMode: null, overageUnitPrice: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null, taxable: false, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const QTY_REQUIRED = 'Enter a quantity (up to 2 decimals).';

function renderEdit(lines: ContractLine[] = []) {
  return render(
    <ContractEditor detail={{ autopayEnabled: false, contract: contract as any, lines, periods: [] }} onChanged={vi.fn()} />,
  );
}

function startManualLine() {
  fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'manual' } });
  fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Licenses' } });
  fireEvent.change(screen.getByTestId('contract-line-price'), { target: { value: '12.00' } });
}

describe('ContractEditor — manual line quantity validation (#10293)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  it('shows no quantity error for the default quantity', async () => {
    renderEdit();
    startManualLine();
    expect(screen.queryByTestId('contract-line-qty-error')).toBeNull();
    expect(screen.getByTestId('contract-line-qty')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('blocks Add with an inline message when the quantity is cleared, without calling the API', async () => {
    renderEdit();
    startManualLine();
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '' } });

    expect(screen.getByTestId('contract-line-qty-error').textContent).toBe(QTY_REQUIRED);
    expect(screen.getByTestId('contract-line-qty')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    expect(api.addContractLine).not.toHaveBeenCalled();
  });

  it('flags a quantity with more than 2 decimals', async () => {
    renderEdit();
    startManualLine();
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '1.234' } });
    expect(screen.getByTestId('contract-line-qty-error').textContent).toBe(QTY_REQUIRED);
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('flags a quantity over the server digit cap with its own message', async () => {
    renderEdit();
    startManualLine();
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '12345678901' } });
    expect(screen.getByTestId('contract-line-qty-error').textContent).toBe('Quantity is too large (at most 10 digits before the decimal point).');
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('sends a valid quantity', async () => {
    renderEdit();
    startManualLine();
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({ lineType: 'manual', manualQuantity: '2.5' });
  });

  it('maps a server manualQuantity field error onto the field instead of toasting raw Zod text', async () => {
    (api.addContractLine as any).mockResolvedValue(resp({
      error: 'manualQuantity: must be a number with up to 2 decimals',
      details: { formErrors: [], fieldErrors: { manualQuantity: ['must be a number with up to 2 decimals'] } },
    }, false, 400));
    renderEdit();
    startManualLine();
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));

    expect((await screen.findByTestId('contract-line-qty-error')).textContent).toBe(QTY_REQUIRED);
    const toasted = vi.mocked(showToast).mock.calls.map(([arg]) => String((arg as { message?: string }).message));
    expect(toasted.some((m) => /must be|money/i.test(m))).toBe(false);

    // Editing the quantity clears the server-reported error.
    fireEvent.change(screen.getByTestId('contract-line-qty'), { target: { value: '3' } });
    expect(screen.queryByTestId('contract-line-qty-error')).toBeNull();
  });

  it('still toasts when the server rejects other fields alongside the quantity', async () => {
    (api.addContractLine as any).mockResolvedValue(resp({
      error: 'manualQuantity: must be a number with up to 2 decimals; description: Too big',
      details: { formErrors: [], fieldErrors: { manualQuantity: ['must be a number with up to 2 decimals'], description: ['Too big'] } },
    }, false, 400));
    renderEdit();
    startManualLine();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    expect((await screen.findByTestId('contract-line-qty-error')).textContent).toBe(QTY_REQUIRED);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('inline edit: clearing a manual quantity shows the message and disables Save', async () => {
    renderEdit([manualLine]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-qty-0'), { target: { value: '' } });
    expect(screen.getByTestId('line-edit-qty-error-0').textContent).toBe(QTY_REQUIRED);
    expect(screen.getByTestId('line-edit-qty-0')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });
});
