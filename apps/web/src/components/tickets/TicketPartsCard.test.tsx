import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketPartsCard from './TicketPartsCard';
import { resetPartnerCurrencyCache } from '../../lib/usePartnerCurrency';

const parts = [{ id: 'p-1', ticketId: 'tk-1', description: 'SSD 1TB', partNumber: null, vendor: null, quantity: '2.00', unitPrice: '99.00', costBasis: '60.00', isBillable: true, billingStatus: 'not_billed', notes: null }];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => {
  resetPartnerCurrencyCache();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === '/tickets/tk-1/parts' ? jsonRes(parts) : jsonRes({}));
});

describe('TicketPartsCard', () => {
  it('lists parts with line totals and margin', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    const row = await screen.findByTestId('ticket-part-p-1');
    expect(row.textContent).toContain('SSD 1TB');
    expect(row.textContent).toContain('2 × $99.00');
    expect(row.textContent).toContain('$198.00');
    expect(row.textContent).toContain('$78.00');
  });

  it('formats line total, unit price and margin in the currency each row carries', async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === '/tickets/tk-1/parts' ? jsonRes(parts.map((p) => ({ ...p, currencyCode: 'GBP' }))) : jsonRes({}));
    render(<TicketPartsCard ticketId="tk-1" />);
    const row = await screen.findByTestId('ticket-part-p-1');
    expect(row.textContent).toContain('2 × £99.00');
    expect(row.textContent).toContain('£198.00');
    expect(row.textContent).toContain('£78.00');
  });

  it('adds a part', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-parts-add-toggle'));
    fireEvent.change(screen.getByTestId('ticket-parts-form-description'), { target: { value: 'RAM 16GB' } });
    fireEvent.change(screen.getByTestId('ticket-parts-form-quantity'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('ticket-parts-form-unit-price'), { target: { value: '45.50' } });
    fireEvent.click(screen.getByTestId('ticket-parts-form-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/tickets/tk-1/parts' && (args[1] as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ description: 'RAM 16GB', quantity: 1, unitPrice: 45.5 });
    });
  });

  it('requires confirmation before deleting — first Delete click does not call the API', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-part-delete-p-1'));
    // Confirm affordance appears; no DELETE request yet
    expect(await screen.findByTestId('ticket-part-delete-confirm-p-1')).toBeTruthy();
    expect(
      fetchWithAuth.mock.calls.some(
        (args) => args[0] === '/tickets/parts/p-1' && (args[1] as RequestInit)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('deletes a part via /tickets/parts/:id after confirming', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-part-delete-p-1'));
    fireEvent.click(await screen.findByTestId('ticket-part-delete-confirm-yes-p-1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/tickets/parts/p-1', expect.objectContaining({ method: 'DELETE' })));
  });

  it('cancel dismisses the confirm without deleting', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-part-delete-p-1'));
    fireEvent.click(await screen.findByTestId('ticket-part-delete-confirm-cancel-p-1'));
    await waitFor(() => expect(screen.queryByTestId('ticket-part-delete-confirm-p-1')).toBeNull());
    expect(
      fetchWithAuth.mock.calls.some(
        (args) => args[0] === '/tickets/parts/p-1' && (args[1] as RequestInit)?.method === 'DELETE',
      ),
    ).toBe(false);
    // Delete button is back
    expect(screen.getByTestId('ticket-part-delete-p-1')).toBeTruthy();
  });

  it('edits a part — preserves costBasis as number, omits sparse fields', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-part-edit-p-1'));
    fireEvent.change(screen.getByTestId('ticket-parts-form-description'), { target: { value: 'SSD 2TB' } });
    fireEvent.click(screen.getByTestId('ticket-parts-form-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === '/tickets/parts/p-1' && (args[1] as RequestInit)?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.costBasis).toBe(60);
      expect(Object.keys(body)).not.toContain('partNumber');
      expect(Object.keys(body)).not.toContain('vendor');
      expect(Object.keys(body)).not.toContain('notes');
    });
  });

  it('adds a part from the catalog — prefills fields and links catalogItemId (#1368)', async () => {
    const catItem = {
      id: 'cat-1', partnerId: 'p1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
      // unitPrice is the deprecated mirror (#3775) — the prefill must come from the price book.
      billingType: 'one_time', unitPrice: '999.00', costBasis: '90.00', costCurrency: 'USD', markupPercent: null, unitOfMeasure: 'each',
      taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
      prices: [{ currencyCode: 'USD', unitPrice: '150.00' }],
    };
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/tickets/tk-1/parts') return jsonRes(parts);
      if (url.startsWith('/catalog')) return jsonRes([catItem]);
      return jsonRes({});
    });

    render(<TicketPartsCard ticketId="tk-1" currencyCode="USD" />);
    fireEvent.click(await screen.findByTestId('ticket-parts-add-toggle'));

    fireEvent.change(await screen.findByTestId('ticket-parts-catalog-picker-input'), { target: { value: 'NVMe' } });
    fireEvent.click(await screen.findByTestId('ticket-parts-catalog-picker-option-cat-1'));

    expect(screen.getByTestId('ticket-parts-form-description')).toHaveValue('NVMe 1TB');
    expect(screen.getByTestId('ticket-parts-form-unit-price')).toHaveValue(150);
    expect(screen.getByTestId('ticket-parts-form-cost-basis')).toHaveValue(90);
    expect(screen.getByTestId('ticket-parts-form-linked')).toHaveTextContent('NVMe 1TB');

    fireEvent.change(screen.getByTestId('ticket-parts-form-quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('ticket-parts-form-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === '/tickets/tk-1/parts' && (args[1] as RequestInit)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
        description: 'NVMe 1TB', unitPrice: 150, catalogItemId: 'cat-1',
      });
    });
  });

  it('unlinks a catalog selection, keeping the prefilled fields free-text', async () => {
    const catItem = {
      id: 'cat-1', partnerId: 'p1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
      billingType: 'one_time', unitPrice: '150.00', costBasis: '90.00', markupPercent: null, unitOfMeasure: 'each',
      taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
    };
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/tickets/tk-1/parts') return jsonRes(parts);
      if (url.startsWith('/catalog')) return jsonRes([catItem]);
      return jsonRes({});
    });

    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-parts-add-toggle'));
    fireEvent.change(await screen.findByTestId('ticket-parts-catalog-picker-input'), { target: { value: 'NVMe' } });
    fireEvent.click(await screen.findByTestId('ticket-parts-catalog-picker-option-cat-1'));

    fireEvent.click(screen.getByTestId('ticket-parts-form-unlink'));
    expect(screen.queryByTestId('ticket-parts-form-linked')).toBeNull();
    expect(screen.getByTestId('ticket-parts-form-description')).toHaveValue('NVMe 1TB');

    fireEvent.change(screen.getByTestId('ticket-parts-form-quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('ticket-parts-form-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === '/tickets/tk-1/parts' && (args[1] as RequestInit)?.method === 'POST',
      );
      expect(JSON.parse((call![1] as RequestInit).body as string).catalogItemId).toBeNull();
    });
  });

  describe('currency-aware catalog prefill (#3775)', () => {
    const catItem = (over: Record<string, unknown> = {}) => ({
      id: 'cat-1', partnerId: 'p1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
      billingType: 'one_time', unitPrice: '999.00', costBasis: '90.00', costCurrency: 'USD', markupPercent: null, unitOfMeasure: 'each',
      taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
      prices: [{ currencyCode: 'EUR', unitPrice: '120.00' }, { currencyCode: 'USD', unitPrice: '150.00' }],
      ...over,
    });
    const pick = async (currencyCode?: string) => {
      render(<TicketPartsCard ticketId="tk-1" currencyCode={currencyCode} />);
      fireEvent.click(await screen.findByTestId('ticket-parts-add-toggle'));
      fireEvent.change(await screen.findByTestId('ticket-parts-catalog-picker-input'), { target: { value: 'NVMe' } });
      fireEvent.click(await screen.findByTestId('ticket-parts-catalog-picker-option-cat-1'));
    };

    it('prefills the EUR price and leaves cost blank when the cost is in USD', async () => {
      fetchWithAuth.mockImplementation(async (url: string) =>
        url.startsWith('/catalog') ? jsonRes([catItem()]) : url === '/tickets/tk-1/parts' ? jsonRes(parts) : jsonRes({}));
      await pick('EUR');
      expect(screen.getByTestId('ticket-parts-form-unit-price')).toHaveValue(120);
      expect(screen.getByTestId('ticket-parts-form-cost-basis')).toHaveValue(null);
    });

    it('leaves the price blank when the book has no row in the org currency (never the unitPrice mirror)', async () => {
      fetchWithAuth.mockImplementation(async (url: string) =>
        url.startsWith('/catalog') ? jsonRes([catItem({ prices: [{ currencyCode: 'USD', unitPrice: '150.00' }] })]) : url === '/tickets/tk-1/parts' ? jsonRes(parts) : jsonRes({}));
      await pick('EUR');
      expect(screen.getByTestId('ticket-parts-form-unit-price')).toHaveValue(null);
      expect(screen.getByTestId('ticket-parts-form-description')).toHaveValue('NVMe 1TB');
    });

    it('leaves price and cost blank when no currency is known', async () => {
      fetchWithAuth.mockImplementation(async (url: string) =>
        url.startsWith('/catalog') ? jsonRes([catItem()]) : url === '/tickets/tk-1/parts' ? jsonRes(parts) : jsonRes({}));
      await pick(undefined);
      expect(screen.getByTestId('ticket-parts-form-unit-price')).toHaveValue(null);
      expect(screen.getByTestId('ticket-parts-form-cost-basis')).toHaveValue(null);
    });
  });
});
