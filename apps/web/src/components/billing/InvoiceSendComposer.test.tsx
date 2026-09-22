import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceSendComposer, { invoiceEmailSubjectPreview } from './InvoiceSendComposer';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'org' }) }));

const onSend = vi.fn();
const props = {
  open: true, onClose: vi.fn(), sending: false, onSend, orgId: 'o1',
  invoiceNumber: null, title: 'Send invoice', intro: 'Review', confirmLabel: 'Send', sendingLabel: 'Sending…',
  partnerDeviceAppendix: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockResolvedValue({
    ok: true, json: vi.fn().mockResolvedValue({ billingContact: { email: 'billing@example.test' } }),
  } as unknown as Response);
});

describe('invoiceEmailSubjectPreview', () => {
  it('fills the saved subject with this invoice', () => {
    expect(invoiceEmailSubjectPreview({
      templateSubject: 'Please pay {{invoice_number}} from {{partner_name}}',
      invoiceNumber: 'INV-2026-0002',
      partnerName: 'CloudWise',
      total: 'CA$90.00',
      dueDate: 'Oct 17, 2026',
    })).toBe('Please pay INV-2026-0002 from CloudWise');
  });

  it('uses the built-in subject when nothing is saved', () => {
    expect(invoiceEmailSubjectPreview({
      templateSubject: null,
      invoiceNumber: 'INV-0007',
      partnerName: 'Acme MSP',
      total: '$100.00',
      dueDate: 'Jun 30, 2026',
    })).toBe('Invoice INV-0007 from Acme MSP');
  });
});

describe('InvoiceSendComposer device appendix (#3205 W07)', () => {
  it('defaults to the partner setting and sends the field ONLY when changed', async () => {
    render(<InvoiceSendComposer {...props} />);
    const box = screen.getByTestId('invoice-send-include-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await waitFor(() => expect(screen.getByTestId('invoice-send-to')).toHaveValue('billing@example.test'));
    await userEvent.click(screen.getByTestId('invoice-send-confirm'));
    expect(onSend.mock.calls[0]![0]).not.toHaveProperty('includeDeviceAppendix');
    onSend.mockClear();
    await userEvent.click(box);
    await userEvent.click(screen.getByTestId('invoice-send-confirm'));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ includeDeviceAppendix: false });
  });

  it('does not offer an appendix override for an issued invoice', () => {
    render(<InvoiceSendComposer {...props} invoiceNumber="INV-1" />);
    expect(screen.queryByTestId('invoice-send-include-device-appendix')).toBeNull();
  });
});
