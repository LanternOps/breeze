import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

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
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(),
    updateContract: vi.fn(),
    addContractLine: vi.fn(),
    removeContractLine: vi.fn(),
    updateContractLine: vi.fn(),
    contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const line = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Endpoints',
  catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null,
  taxable: true, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z', ...p,
});

const estimateLine = (p: Partial<Record<string, unknown>> = {}) => ({
  lineId: 'l1', lineType: 'per_device', quantity: 25, value: '250.00', live: true,
  counted: 26, included: 25, overage: 1, overageMode: 'bill', overageValue: '12.00', ...p,
});

describe('ContractEditor — allowance block (#3205 W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
    (api.updateContractLine as any).mockResolvedValue(resp({ data: line() }));
  });

  function renderEdit(lines: unknown[] = []) {
    return render(<ContractEditor detail={{ contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
  }

  it('offers the allowance block only on the four counted types, and clears it on type change', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-allowance-toggle')).toBeNull();
    for (const lineType of ['per_device', 'per_device_role', 'per_device_group', 'per_seat']) {
      fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: lineType } });
      expect(await screen.findByTestId('contract-line-allowance-toggle')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('contract-line-allowance-toggle'));
    fireEvent.change(await screen.findByTestId('contract-line-included-qty'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'manual' } });
    expect(screen.queryByTestId('contract-line-allowance-toggle')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    expect((await screen.findByTestId('contract-line-allowance-toggle') as HTMLInputElement).checked).toBe(false);
  });

  it('disables Add until the allowance is complete, in each mode', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '25' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '12.00' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-overage-flag'));
    expect(screen.queryByTestId('contract-line-overage-price')).toBeNull();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('enforces positive-integer quantities and the unit-price money grammar at their boundaries', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '25' } });

    for (const includedQuantity of ['', '0', '-1', '2.5', 'abc']) {
      fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: includedQuantity } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }

    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '1' } });
    for (const overageUnitPrice of ['', '-1', '2.555', 'abc']) {
      fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: overageUnitPrice } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }

    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '25' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('shows the currency-representability hint for an invalid add-form overage price', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '1.001' } });
    expect(screen.getByTestId('contract-line-overage-price-not-representable')).toHaveTextContent('USD');
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('groups both overage-mode choices under a translated legend', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    expect(screen.getByTestId('contract-line-overage-mode-group').querySelector('legend')).toHaveTextContent(/extras beyond/i);
  });

  it('omits unchanged allowance keys when only an allowed line description changes', async () => {
    renderEdit([line({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' })]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed endpoints' } });
    const save = screen.getByTestId('line-edit-save-0');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({ description: 'Renamed endpoints' });
  });

  it('enables an allowance with exactly its three PATCH keys', async () => {
    renderEdit([line()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-allowance-toggle-0'));
    fireEvent.change(screen.getByTestId('line-edit-included-qty-0'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('line-edit-overage-price-0'), { target: { value: '12.00' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
  });

  it('removes an allowance by sending all three PATCH keys as null', async () => {
    renderEdit([line({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' })]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-allowance-toggle-0'));
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({
      includedQuantity: null, overageMode: null, overageUnitPrice: null,
    });
  });

  it('switches bill to flag while explicitly clearing the overage unit price', async () => {
    renderEdit([line({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' })]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-overage-flag-0'));
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({ overageMode: 'flag', overageUnitPrice: null });
  });

  it('disables Save and shows the USD hint for bill mode with an invalid price', async () => {
    renderEdit([line({ includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' })]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-overage-price-0'), { target: { value: '1.001' } });
    expect(screen.getByTestId('line-edit-overage-price-not-representable-0')).toHaveTextContent('USD');
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  it('disables Save for an incomplete newly enabled bill allowance', async () => {
    renderEdit([line()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-allowance-toggle-0'));
    fireEvent.change(screen.getByTestId('line-edit-included-qty-0'), { target: { value: '25' } });
    expect(screen.getByTestId('line-edit-overage-price-0')).toHaveValue(null);
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  it('sends the allowance keys only when the box is checked', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const plain = (api.addContractLine as any).mock.calls[0][1];
    expect(plain.includedQuantity).toBeUndefined();
    expect(plain.overageMode).toBeUndefined();
    expect(plain.overageUnitPrice).toBeUndefined();

    (api.addContractLine as any).mockClear();
    fireEvent.click(await screen.findByTestId('contract-line-allowance-toggle'));
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '25' } });
    fireEvent.change(screen.getByTestId('contract-line-overage-price'), { target: { value: '12.00' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });

    (api.addContractLine as any).mockClear();
    fireEvent.click(screen.getByTestId('contract-line-allowance-toggle'));
    fireEvent.change(screen.getByTestId('contract-line-included-qty'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('contract-line-overage-flag'));
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Endpoints' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const flagged = (api.addContractLine as any).mock.calls[0][1];
    expect(flagged).toMatchObject({ includedQuantity: '25', overageMode: 'flag' });
    expect(flagged.overageUnitPrice).toBeUndefined();
  });

  it('renders all five AllowanceCell states in the line table', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: {
        currencyCode: 'USD', periodTotal: '0.00', uncoveredDevices: null, overages: [],
        lines: [
          estimateLine({ lineId: 'l-none', included: null, overage: 0, overageMode: null, counted: 7, quantity: 7, overageValue: '0.00' }),
          estimateLine({ lineId: 'l-within', counted: 18, quantity: 25, overage: 0, overageValue: '0.00' }),
          estimateLine({ lineId: 'l-bill' }),
          estimateLine({ lineId: 'l-flag', overageMode: 'flag', overageValue: '0.00' }),
        ],
      },
    }));
    renderEdit([
      line({ id: 'l-none' }),
      line({ id: 'l-within', includedQuantity: '25.00', overageMode: 'flag' }),
      line({ id: 'l-bill', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }),
      line({ id: 'l-flag', includedQuantity: '25.00', overageMode: 'flag' }),
      line({ id: 'l-noest', includedQuantity: '25.00', overageMode: 'flag' }),
    ]);
    expect((await screen.findByTestId('line-qty-0')).textContent).toBe('7');
    expect(screen.getByTestId('line-qty-1').textContent).toMatch(/18.*25/);
    expect(screen.getByTestId('line-qty-2').textContent).toMatch(/25.*1/);
    expect(screen.getByTestId('line-qty-2').querySelector('[data-testid="allowance-over-billed"]')).not.toBeNull();
    expect(screen.getByTestId('line-qty-3').querySelector('[data-testid="allowance-over-flagged"]')).not.toBeNull();
    expect(screen.getByTestId('line-qty-4').querySelector('[data-testid="allowance-included-only"]')).not.toBeNull();
  });

  it('renders the overage digest under the coverage notice', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: {
        currencyCode: 'USD', periodTotal: '262.00', lines: [], uncoveredDevices: null,
        overages: [
          { contractLineId: 'l1', invoiceLineId: null, description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'flag' },
          { contractLineId: 'l2', invoiceLineId: 'il2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
        ],
      },
    }));
    renderEdit();
    expect(await screen.findByTestId('contract-overage-flagged')).toHaveTextContent('Endpoints');
    expect(screen.getByTestId('contract-overage-billed')).toHaveTextContent('Servers');
  });
});
