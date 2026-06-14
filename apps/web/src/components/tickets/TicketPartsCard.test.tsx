import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketPartsCard from './TicketPartsCard';

const parts = [{ id: 'p-1', ticketId: 'tk-1', description: 'SSD 1TB', partNumber: null, vendor: null, quantity: '2.00', unitPrice: '99.00', costBasis: '60.00', isBillable: true, billingStatus: 'not_billed', notes: null }];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => {
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
});
