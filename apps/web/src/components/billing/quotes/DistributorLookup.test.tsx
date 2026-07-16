// apps/web/src/components/billing/quotes/DistributorLookup.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressLookup = vi.fn();
const tdSynnexSftpProducts = vi.fn();
vi.mock('../../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/distributors')>()),
  ecExpressLookup: (...a: unknown[]) => ecExpressLookup(...a),
  tdSynnexSftpProducts: (...a: unknown[]) => tdSynnexSftpProducts(...a),
}));

import DistributorLookup from './DistributorLookup';
import type { EcProduct, SftpProduct } from '../../../lib/api/distributors';

const product: EcProduct = {
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', status: 'Active',
  name: 'Widget', description: 'A widget', currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
};

// Drizzle numerics arrive as strings — the fixtures mirror that on purpose.
const nightlyRow = (over: Partial<SftpProduct> = {}): SftpProduct => ({
  synnexSku: 'NF001', mfgPartNo: 'LEN-DOCK-1', tdPartNo: 'TD-1', name: 'Lenovo ThinkPad Dock',
  description: null, manufacturer: 'LENOVO', status: 'C', abcCode: 'A', currency: 'USD',
  cost: '210.5000', costWithoutPromo: '225.0000', msrp: '299.9900', mapPrice: null,
  totalQty: 12, warehouses: [{ code: 'DFW', loc: '501', city: 'Fort Worth', state: 'TX', available: 9 },
    { code: 'ATL', loc: '502', city: 'Atlanta', state: 'GA', available: 3 }],
  weight: '3.100', upc: null, unspsc: null, etaDate: null, fileDate: '2026-07-13',
  syncedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
  ...over,
});

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

const selectNightly = (blockId = 'b1') =>
  fireEvent.change(screen.getByTestId(`quote-distributor-source-${blockId}`), { target: { value: 'nightly' } });

beforeEach(() => {
  ecExpressLookup.mockReset();
  tdSynnexSftpProducts.mockReset();
  tdSynnexSftpProducts.mockResolvedValue(ok([]));
});

describe('DistributorLookup — EC Express (exact lookup)', () => {
  it('searches and lists results with a prefilled price', async () => {
    ecExpressLookup.mockResolvedValue(ok([product]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-b1'));
    await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('100.00');
    // The default source must stay EC Express — the live lookup is not debounced.
    expect(tdSynnexSftpProducts).not.toHaveBeenCalled();
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

describe('DistributorLookup — nightly catalog (keyword search)', () => {
  it('debounced keyword search hits the nightly endpoint, not EC Express', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([nightlyRow()]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'lenovo dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-result-NF001'));
    expect(tdSynnexSftpProducts).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'lenovo dock', inStockOnly: false }),
    );
    expect(ecExpressLookup).not.toHaveBeenCalled();
    // Sell price seeds from MSRP even though the API sends numerics as strings.
    expect((screen.getByTestId('quote-distributor-price-NF001') as HTMLInputElement).value).toBe('299.99');
  });

  it('requires >= 3 characters before firing', async () => {
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'le' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(tdSynnexSftpProducts).not.toHaveBeenCalled();
    expect((screen.getByTestId('quote-distributor-search-btn-b1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('debounces bursts of keystrokes into a single request', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([nightlyRow()]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    const input = screen.getByTestId('quote-distributor-search-b1');
    for (const value of ['len', 'leno', 'lenov', 'lenovo']) {
      fireEvent.change(input, { target: { value } });
    }
    await waitFor(() => screen.getByTestId('quote-distributor-result-NF001'));
    expect(tdSynnexSftpProducts).toHaveBeenCalledTimes(1);
    expect(tdSynnexSftpProducts).toHaveBeenCalledWith(expect.objectContaining({ q: 'lenovo' }));
  });

  it('badges an end-of-life SKU (abcCode C) and a to-be-discontinued SKU (abcCode T)', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([
      nightlyRow({ synnexSku: 'EOL001', abcCode: 'C' }),
      nightlyRow({ synnexSku: 'TBD001', abcCode: 'T' }),
      nightlyRow({ synnexSku: 'OK001', abcCode: 'A' }),
    ]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-result-EOL001'));
    expect(screen.getByTestId('quote-distributor-eol-EOL001').textContent).toBe('End of life');
    expect(screen.getByTestId('quote-distributor-eol-TBD001').textContent).toBe('To be discontinued');
    expect(screen.queryByTestId('quote-distributor-eol-OK001')).toBeNull();
  });

  it('badges out-of-stock rows and shows the freshness marker + warehouses', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([
      nightlyRow({ synnexSku: 'ZERO1', totalQty: 0, warehouses: [] }),
      nightlyRow({ synnexSku: 'NF001' }),
    ]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-result-ZERO1'));
    expect(screen.getByTestId('quote-distributor-oos-ZERO1')).toBeTruthy();
    expect(screen.queryByTestId('quote-distributor-oos-NF001')).toBeNull();
    // Nightly snapshot, not live: every row says how stale it is.
    expect(screen.getByTestId('quote-distributor-freshness-NF001').textContent).toBe('synced 6h ago');
    expect(screen.getByTestId('quote-distributor-warehouses-NF001').textContent).toContain('DFW 9');
  });

  it('in-stock-only toggle re-queries with inStockOnly', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([nightlyRow()]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-result-NF001'));
    fireEvent.click(screen.getByTestId('quote-distributor-instock-b1'));
    await waitFor(() => expect(tdSynnexSftpProducts).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'dock', inStockOnly: true }),
    ));
  });

  it('imports a nightly row as an EC-shaped product with numeric cost/msrp', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([nightlyRow()]));
    const onImportAdd = vi.fn();
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-add-NF001'));
    fireEvent.click(screen.getByTestId('quote-distributor-add-NF001'));
    expect(onImportAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        // Provenance must survive the shape adaptation. A catalog item built
        // from a nightly snapshot must NOT read back as a live EC Express
        // lookup — that field is what you check when a price looks stale.
        source: 'td_synnex_price_file',
        synnexSku: 'NF001',
        name: 'Lenovo ThinkPad Dock',
        cost: 210.5,
        msrp: 299.99,
        totalQty: 12,
      }),
      299.99,
    );
  });

  it('surfaces an empty result set instead of a silent no-op', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'zzzz' } });
    await waitFor(() => screen.getByTestId('quote-distributor-empty-b1'));
  });

  it('shows an inline error when the nightly search fails', async () => {
    tdSynnexSftpProducts.mockResolvedValue(new Response('{"error":"boom"}', { status: 500 }));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => expect(screen.getByTestId('quote-distributor-error-b1').textContent).toBe('boom'));
  });

  it('clears results when switching back to EC Express', async () => {
    tdSynnexSftpProducts.mockResolvedValue(ok([nightlyRow()]));
    render(<DistributorLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
    selectNightly();
    fireEvent.change(screen.getByTestId('quote-distributor-search-b1'), { target: { value: 'dock' } });
    await waitFor(() => screen.getByTestId('quote-distributor-result-NF001'));
    fireEvent.change(screen.getByTestId('quote-distributor-source-b1'), { target: { value: 'ec_express' } });
    expect(screen.queryByTestId('quote-distributor-result-NF001')).toBeNull();
  });
});
