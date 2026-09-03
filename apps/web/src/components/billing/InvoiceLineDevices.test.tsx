/**
 * #3205 W07 — the per-line device disclosure. Read-only, so no runAction is
 * involved (and none should be added).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InvoiceLineDevices from './InvoiceLineDevices';
import type { InvoiceLine, InvoiceLineDevice } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchSpy = vi.mocked(fetchWithAuth);
const BASE_LINE: InvoiceLine = {
  id: 'l1', invoiceId: 'i1', sourceType: 'manual', parentLineId: null,
  catalogItemId: null, name: 'Managed devices', description: null,
  quantity: '2.00', unitPrice: '10.00', costBasis: null,
  revenueAllocation: null, taxable: false, customerVisible: true,
  lineTotal: '20.00', isUnapprovedTime: false, sortOrder: 0, deviceCount: 2,
};
const line = (over: Partial<InvoiceLine> = {}) => ({ ...BASE_LINE, ...over });
const device = (over: Partial<InvoiceLineDevice> = {}): InvoiceLineDevice => ({
  id: 'e1', deviceId: 'd1', hostname: 'alpha-01', deviceRole: 'server',
  siteId: null, countedAs: 'included', ...over,
});
const response = (data: unknown): Response => ({
  ok: true, status: 200, json: vi.fn().mockResolvedValue({ data }),
}) as unknown as Response;

describe('InvoiceLineDevices (#3205 W07)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    window.location.hash = '';
  });

  it('renders no toggle when deviceCount is 0', () => {
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 0 })} />);
    expect(screen.queryByTestId('invoice-line-devices-toggle-l1')).toBeNull();
  });

  it('fetches ONCE on first expand and not again on collapse+expand', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 2, devices: [
      device(), device({ id: 'e2', deviceId: 'd2', hostname: 'beta-02' }),
    ], nextCursor: null }));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-l1')).toBeTruthy());
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keys rows by the EVIDENCE id — two detached rows sharing a hostname render as two rows', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 2, nextCursor: null, devices: [
      device({ id: 'e1', deviceId: null, hostname: 'dup' }),
      device({ id: 'e2', deviceId: null, hostname: 'dup' }),
    ] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-device-e1')).toBeTruthy());
    expect(screen.getByTestId('invoice-line-device-e2')).toBeTruthy();
  });

  it('shows the device-removed marker for a null deviceId', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 1, nextCursor: null, devices: [device({ deviceId: null })] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 1 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-device-removed-e1')).toBeTruthy());
  });

  it('renders FLAGGED devices under their own sub-heading BELOW the billed rows', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 2, nextCursor: null, devices: [
      device({ id: 'e1', hostname: 'billed-01', countedAs: 'included' }),
      device({ id: 'e2', hostname: 'flagged-99', countedAs: 'flagged' }),
    ] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-flagged-l1')).toBeTruthy());
    const billed = screen.getByTestId('invoice-line-devices-l1');
    const flagged = screen.getByTestId('invoice-line-devices-flagged-l1');
    expect(billed.compareDocumentPosition(flagged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows "showing N of M" when the page is short of the total', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 1240, nextCursor: 'c', devices: [device()] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 1240 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-showing-l1').textContent).toContain('1240'));
  });

  it('follows nextCursor when loading another page', async () => {
    fetchSpy
      .mockResolvedValueOnce(response({ recorded: true, total: 2, nextCursor: 'cursor-2', devices: [device()] }))
      .mockResolvedValueOnce(response({ recorded: true, total: 2, nextCursor: null, devices: [device({ id: 'e2' })] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await userEvent.click(await screen.findByTestId('invoice-line-devices-showing-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-device-e2')).toBeTruthy());
    expect(fetchSpy).toHaveBeenLastCalledWith('/invoices/i1/lines/l1/devices?limit=100&cursor=cursor-2');
  });

  it('renders an explicit EMPTY list — never the not-recorded notice — when a recorded fetch returns zero rows', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 0, nextCursor: null, devices: [] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line({ deviceCount: 2 })} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-empty-l1')).toBeTruthy());
    expect(screen.queryByTestId('invoice-devices-not-recorded')).toBeNull();
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-error-l1')).toBeTruthy());
  });

  it('two instances stay independently expanded — expanding a second line does not force-close the first (hash isolation, #3205 W07 review)', async () => {
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 1, nextCursor: null, devices: [device()] }));
    render(
      <>
        <InvoiceLineDevices invoiceId="i1" line={line({ id: 'l1' })} />
        <InvoiceLineDevices invoiceId="i1" line={line({ id: 'l2' })} />
      </>,
    );
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-l1')).toBeTruthy());

    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l2'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-l2')).toBeTruthy());

    // Expanding l2 must not have collapsed l1.
    expect(screen.getByTestId('invoice-line-devices-l1')).toBeTruthy();
    expect(window.location.hash).toContain('l1');
    expect(window.location.hash).toContain('l2');

    // Collapsing l1 must leave l2 open.
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.queryByTestId('invoice-line-devices-l1')).toBeNull());
    expect(screen.getByTestId('invoice-line-devices-l2')).toBeTruthy();
    expect(window.location.hash).not.toContain('l1');
    expect(window.location.hash).toContain('l2');
  });

  it('preserves an unrelated hash segment already present (e.g. InvoiceDetail\'s #editor) when opening/closing', async () => {
    window.location.hash = '#editor';
    fetchSpy.mockResolvedValue(response({ recorded: true, total: 1, nextCursor: null, devices: [device()] }));
    render(<InvoiceLineDevices invoiceId="i1" line={line()} />);
    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.getByTestId('invoice-line-devices-l1')).toBeTruthy());
    expect(window.location.hash).toContain('editor');
    expect(window.location.hash).toContain('l1');

    await userEvent.click(screen.getByTestId('invoice-line-devices-toggle-l1'));
    await waitFor(() => expect(screen.queryByTestId('invoice-line-devices-l1')).toBeNull());
    expect(window.location.hash).toContain('editor');
    expect(window.location.hash).not.toContain('devices=');
  });
});
