// apps/web/src/components/billing/quotes/DistributorLookup.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressLookup = vi.fn();
vi.mock('../../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/distributors')>()),
  ecExpressLookup: (...a: unknown[]) => ecExpressLookup(...a),
}));

import DistributorLookup from './DistributorLookup';
import type { EcProduct } from '../../../lib/api/distributors';

const product: EcProduct = {
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', status: 'Active',
  name: 'Widget', description: 'A widget', currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
};
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => { ecExpressLookup.mockReset(); });

describe('DistributorLookup', () => {
  it('searches and lists results with a prefilled price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('100.00');
  });

  it('calls onImportAdd with the (possibly edited) price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    const onImportAdd = vi.fn();
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
    fireEvent.change(screen.getByTestId('quote-distributor-price-ABC123'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    expect(onImportAdd).toHaveBeenCalledWith(product, 120);
  });

  it('shows an inline error when lookup fails', async () => {
    ecExpressLookup.mockResolvedValue(new Response('{"error":"nope"}', { status: 500 }));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-error-b1'));
  });

  it('disables Import & add and ignores clicks for an invalid price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    const onImportAdd = vi.fn();
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-add-ABC123'));
    for (const bad of ['', '-5']) {
      fireEvent.change(screen.getByTestId('quote-distributor-price-ABC123'), { target: { value: bad } });
      expect((screen.getByTestId('quote-distributor-add-ABC123') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    }
    expect(onImportAdd).not.toHaveBeenCalled();
  });
});
