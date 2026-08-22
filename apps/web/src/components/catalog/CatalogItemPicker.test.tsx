import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import CatalogItemPicker from './CatalogItemPicker';
import { resetPartnerCurrencyCache } from '../../lib/usePartnerCurrency';
import type { CatalogItem } from '../../lib/api/catalog';

const jsonRes = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

const ITEM: CatalogItem = {
  id: 'w1', partnerId: 'p1', itemType: 'service', name: 'Widget Service', sku: 'WID-1',
  description: null, billingType: 'one_time', unitPrice: '12.00', costBasis: null,
  markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
  isActive: true, isBundle: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
} as CatalogItem;

beforeEach(() => {
  resetPartnerCurrencyCache();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === '/orgs/partners/me' ? jsonRes({ id: 'p1', currencyCode: 'GBP' }) : jsonRes({}));
});

describe('CatalogItemPicker', () => {
  it('labels unit prices with an explicit currencyCode prop', async () => {
    render(<CatalogItemPicker items={[ITEM]} onSelect={() => {}} currencyCode="EUR" />);
    fireEvent.focus(screen.getByTestId('catalog-picker-input'));
    const option = await screen.findByTestId('catalog-picker-option-w1');
    expect(option.textContent).toContain('€12.00');
  });

  it('defaults to the partner currency when no currencyCode is passed', async () => {
    render(<CatalogItemPicker items={[ITEM]} onSelect={() => {}} />);
    fireEvent.focus(screen.getByTestId('catalog-picker-input'));
    const option = await screen.findByTestId('catalog-picker-option-w1');
    await waitFor(() => expect(option.textContent).toContain('£12.00'));
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('filters by name or SKU and reports the pick', async () => {
    const onSelect = vi.fn();
    render(<CatalogItemPicker items={[ITEM, { ...ITEM, id: 'x2', name: 'Other', sku: 'OTH-2' }]} onSelect={onSelect} currencyCode="USD" />);
    const input = screen.getByTestId('catalog-picker-input');
    fireEvent.change(input, { target: { value: 'wid' } });
    expect(await screen.findByTestId('catalog-picker-option-w1')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-picker-option-x2')).toBeNull();
    fireEvent.click(screen.getByTestId('catalog-picker-option-w1'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }));
    expect((input as HTMLInputElement).value).toBe('');
  });
});
