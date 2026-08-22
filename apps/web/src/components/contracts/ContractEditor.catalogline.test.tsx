// Multi-currency wave 3 (#3775): a catalog-linked contract line is priced by the
// server from the price book in the CONTRACT's currency. The editor shows that
// price read-only, never sends unitPrice/taxable for it, and blocks the add on a
// price-book gap (the server would refuse with NO_PRICE_FOR_CURRENCY anyway).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import type { ContractDetail } from '../../lib/api/contracts';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import type { CatalogItem } from '../../lib/api/catalog';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// The picker's own rendering is covered in CatalogItemPicker.test.tsx; here a
// stub exposes one button per item so the test can "pick" deterministically and
// assert the currency the editor hands the picker.
const picker = vi.hoisted(() => ({ lastCurrency: '' as string }));
vi.mock('../catalog/CatalogItemPicker', () => ({
  default: ({ items, onSelect, currencyCode }: { items: CatalogItem[]; onSelect: (i: CatalogItem) => void; currencyCode: string }) => {
    picker.lastCurrency = currencyCode;
    return (
      <div data-testid="picker-stub">
        {items.map((i) => <button key={i.id} type="button" data-testid={`pick-${i.id}`} onClick={() => onSelect(i)}>{i.name}</button>)}
      </div>
    );
  },
}));
const catalogRows = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('../../lib/api/catalog', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/catalog')>()),
  listCatalog: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: catalogRows.items }) })),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(),
    removeContractLine: vi.fn(), contractTransition: vi.fn(), getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const catItem = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'cat-1', partnerId: 'p1', itemType: 'service', name: 'Managed workstation', sku: 'MW-1', description: null,
  billingType: 'recurring', unitPrice: '999.00', costBasis: '20.00', costCurrency: 'USD', markupPercent: null,
  unitOfMeasure: 'each', taxable: true, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
  prices: [{ currencyCode: 'EUR', unitPrice: '42.00' }, { currencyCode: 'USD', unitPrice: '50.00' }],
  ...over,
});

const eurDraft: ContractDetail = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'EUR', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [],
  periods: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  catalogRows.items = [catItem()];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return resp({ data: [] });
    return resp({ data: {} });
  });
  (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'EUR', periodTotal: '0.00', lines: [] } }));
  (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'cl-9' } }));
});

describe('ContractEditor — catalog line pricing (#3775)', () => {
  it('hands the picker the contract currency, shows the EUR price read-only, and omits unitPrice/taxable from the POST', async () => {
    render(<ContractEditor detail={eurDraft} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('pick-cat-1'));
    expect(picker.lastCurrency).toBe('EUR');

    const price = screen.getByTestId('contract-line-price') as HTMLInputElement;
    expect(price).toHaveValue(42);
    expect(price).toHaveAttribute('readonly');
    // A tech cannot type a custom price over a catalog link — clear the link instead.
    fireEvent.change(price, { target: { value: '7' } });
    expect(price).toHaveValue(42);
    expect(screen.getByTestId('contract-line-taxable')).toBeDisabled();
    expect(screen.getByTestId('contract-line-taxable')).toBeChecked();
    expect(screen.queryByTestId('contract-line-price-missing')).toBeNull();

    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const body = (api.addContractLine as any).mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ catalogItemId: 'cat-1', description: 'Managed workstation' });
    expect(body).not.toHaveProperty('unitPrice', expect.anything());
    expect(body.unitPrice).toBeUndefined();
    expect(body.taxable).toBeUndefined();
  });

  it('blocks the add and names the currency when the item has no contract-currency price', async () => {
    catalogRows.items = [catItem({ prices: [{ currencyCode: 'USD', unitPrice: '50.00' }] })];
    render(<ContractEditor detail={eurDraft} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('pick-cat-1'));

    expect(screen.getByTestId('contract-line-price-missing')).toHaveTextContent('No EUR price');
    expect(screen.getByTestId('contract-line-price')).toHaveValue(null);
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    // Clearing the catalog link restores the manual path with an editable price.
    fireEvent.click(screen.getByLabelText('Clear catalog link'));
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    expect(screen.getByTestId('contract-line-price')).not.toHaveAttribute('readonly');
  });

  it('toasts the gap message when the server answers NO_PRICE_FOR_CURRENCY', async () => {
    (api.addContractLine as any).mockResolvedValue(resp({ error: 'No price in EUR', code: 'NO_PRICE_FOR_CURRENCY' }, false, 409));
    render(<ContractEditor detail={eurDraft} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('pick-cat-1'));
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'No EUR price for this item. Add one in the catalog or clear the catalog link.',
    })));
  });
});
