import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceActions from './InvoiceActions';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [{ resource: '*', action: '*' }] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
// Partner scope so the composer's signature-preview fetch is attempted at all.
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const line: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: null, description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1, deviceCount: 0,
};

/** An issued, already-emailed invoice — the state Re-send exists for. */
function detail(extra: Partial<InvoiceDetail['invoice']> = {}, top: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
      currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30',
      sentAt: '2026-06-01T10:00:00Z', subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
      ...extra,
    },
    lines: [line],
    ...top,
  };
}

/** Default network: org lookup prefills a billing contact, partner has a
 *  signature, and the re-send reports a delivered email. */
function defaultFetch(overrides: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/orgs/organizations/')) return json({ billingContact: { email: 'ap@acme.test' } });
    if (input === '/orgs/partners/me') return json({ emailSignature: '— Todd' });
    if (input.endsWith('/resend')) return json({ data: { emailed: true, recipients: ['ap@acme.test'] }, ...overrides });
    if (input.endsWith('/public-link')) return json({ data: { url: 'https://portal.test/portal/invoice/tok-abc' } });
    return json({ data: {} });
  });
}

const clipboard = { writeText: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: '*', action: '*' }];
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
  defaultFetch();
});

/** Open the composer and wait for the billing-contact prefill to land. */
async function openComposer() {
  fireEvent.click(screen.getByTestId('invoice-resend'));
  const to = await screen.findByTestId('invoice-send-to');
  await waitFor(() => expect(to).toHaveValue('ap@acme.test'));
  return to;
}

describe('InvoiceActions — re-send', () => {
  it('offers Re-send on an issued invoice and hides it on a draft', () => {
    const { unmount } = render(<InvoiceActions detail={detail()} variant="rail" />);
    expect(screen.getByTestId('invoice-resend')).toHaveTextContent('Re-send');
    unmount();
    render(<InvoiceActions detail={detail({ status: 'draft', invoiceNumber: null, sentAt: null })} variant="rail" />);
    expect(screen.queryByTestId('invoice-resend')).not.toBeInTheDocument();
  });

  // Never re-mail a demand we already cancelled.
  it('hides Re-send on a void invoice', () => {
    render(<InvoiceActions detail={detail({ status: 'void' })} variant="rail" />);
    expect(screen.queryByTestId('invoice-resend')).not.toBeInTheDocument();
  });

  // "Send me a copy for our records" is the commonest reason a customer asks,
  // and unlike a quote's accept link this email dispenses no credential.
  it('still offers Re-send on a PAID invoice', () => {
    render(<InvoiceActions detail={detail({ status: 'paid', amountPaid: '100.00', balance: '0.00' })} variant="rail" />);
    expect(screen.getByTestId('invoice-resend')).toBeInTheDocument();
  });

  it('requires invoices:send', () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }, { resource: 'invoices', action: 'export' }];
    render(<InvoiceActions detail={detail()} variant="rail" />);
    expect(screen.queryByTestId('invoice-resend')).not.toBeInTheDocument();
  });

  it('prefills To from the org billing contact and previews the partner signature', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    expect(await screen.findByTestId('invoice-send-signature-preview')).toHaveTextContent('— Todd');
  });

  it('POSTs the composed envelope to /resend', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-cc-toggle'));
    fireEvent.change(screen.getByTestId('invoice-send-cc'), { target: { value: 'books@acme.test' } });
    fireEvent.change(screen.getByTestId('invoice-send-subject'), { target: { value: 'Copy of INV-0007' } });
    fireEvent.change(screen.getByTestId('invoice-send-message'), { target: { value: 'As discussed.' } });
    fireEvent.click(screen.getByTestId('invoice-send-include-pdf')); // uncheck
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/resend');
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        to: ['ap@acme.test'], cc: ['books@acme.test'], subject: 'Copy of INV-0007',
        message: 'As discussed.', includePdf: false,
      });
    });
  });

  // Omitting untouched fields is what lets the server apply its own defaults
  // (standard subject, PDF attached) rather than being handed empty strings.
  it('omits every field the sender left alone', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/resend');
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ to: ['ap@acme.test'] });
    });
  });

  it('refuses an invalid address and names it, without sending', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    const to = await openComposer();
    fireEvent.change(to, { target: { value: 'not-an-email' } });
    expect(await screen.findByTestId('invoice-send-to-error')).toHaveTextContent('not-an-email');
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/resend')).toBe(false));
  });

  it('an empty To explains itself rather than sitting dead', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    const to = await openComposer();
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    expect(await screen.findByTestId('invoice-send-to-missing')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/resend')).toBe(false);
  });

  it('explains an empty To when the org genuinely has no billing contact', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations/')) return json({ billingContact: null });
      if (input === '/orgs/partners/me') return json({ emailSignature: null });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail()} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-resend'));
    expect(await screen.findByTestId('invoice-send-to-no-contact')).toBeInTheDocument();
  });

  // A failed org lookup is UNKNOWN, not absent — claiming "no billing contact"
  // there would be false.
  it('stays silent about the billing contact when the lookup itself failed', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations/')) return json({}, false, 500);
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail()} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-resend'));
    await screen.findByTestId('invoice-send-to');
    expect(screen.queryByTestId('invoice-send-to-no-contact')).not.toBeInTheDocument();
  });

  it('toasts success and closes the composer when an email actually went out', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Invoice re-sent' }));
    expect(screen.queryByTestId('invoice-send-to')).not.toBeInTheDocument();
  });

  // The server swallows delivery failures, so a 200 does not mean delivered.
  it('warns instead of claiming success when emailed is false', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations/')) return json({ billingContact: { email: 'ap@acme.test' } });
      if (input.endsWith('/resend')) return json({ data: { emailed: false, reason: 'no_email_service' } });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'warning', message: expect.stringContaining('No email was sent') }));
  });

  // An unexpected response shape must not read as success.
  it('warns when the response carries no emailed flag at all', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations/')) return json({ billingContact: { email: 'ap@acme.test' } });
      if (input.endsWith('/resend')) return json({ data: {} });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'warning', message: expect.any(String) }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  // The typed recipients and note must survive a failure so the retry is one click.
  it('leaves the composer open when the request fails', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/orgs/organizations/')) return json({ billingContact: { email: 'ap@acme.test' } });
      if (input.endsWith('/resend')) return json({ error: 'boom' }, false, 500);
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail()} variant="header" />);
    await openComposer();
    fireEvent.change(screen.getByTestId('invoice-send-message'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/resend')).toBe(true));
    expect(screen.getByTestId('invoice-send-message')).toHaveValue('keep me');
  });

  // A first email after a bare Issue is a genuine SEND: /send stamps sent_at.
  it('an issued-but-never-emailed invoice sends via /send, not /resend', async () => {
    render(<InvoiceActions detail={detail({ sentAt: null })} variant="header" />);
    expect(screen.getByTestId('invoice-resend')).toHaveTextContent('Send invoice');
    await openComposer();
    fireEvent.click(screen.getByTestId('invoice-send-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/send')).toBe(true));
    expect(fetchMock.mock.calls.some((c) => c[0] === '/invoices/inv-1/resend')).toBe(false);
  });

  it('reads "Request payment" once the customer has part-paid', () => {
    render(<InvoiceActions detail={detail({ status: 'partially_paid', amountPaid: '40.00', balance: '60.00' })} variant="rail" />);
    expect(screen.getByTestId('invoice-resend')).toHaveTextContent('Request payment');
  });
});

describe('InvoiceActions — copy invoice link', () => {
  it('copies the durable public view-and-pay URL to the clipboard', async () => {
    render(<InvoiceActions detail={detail({}, { stripeConnected: true })} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-pay-link'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('https://portal.test/portal/invoice/tok-abc'));
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Payment link copied to clipboard' });
    // GET mint-or-reproduce — never the one-shot Stripe checkout POST.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/pay-link'))).toBe(false);
  });

  // A blocked clipboard must still surface the URL — a silent no-op reads as a
  // dead button.
  it('surfaces the URL when the clipboard is denied', async () => {
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    render(<InvoiceActions detail={detail({}, { stripeConnected: true })} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-pay-link'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', message: expect.stringContaining('https://portal.test/portal/invoice/tok-abc'),
    })));
  });

  // A 200 with no link is a server surprise, not something to paste.
  it('errors rather than copying "undefined" when no url comes back', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.endsWith('/public-link')) return json({ data: {} });
      return json({ data: {} });
    });
    render(<InvoiceActions detail={detail({}, { stripeConnected: true })} variant="header" />);
    fireEvent.click(screen.getByTestId('invoice-pay-link'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: expect.any(String) }));
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  // The public page degrades to view+PDF without Stripe, so the link stays
  // copyable — unlike the old one-shot Stripe checkout copy.
  it('is visible without Stripe connected', () => {
    render(<InvoiceActions detail={detail({}, { stripeConnected: false })} variant="header" />);
    expect(screen.getByTestId('invoice-pay-link')).toBeInTheDocument();
  });

  // "Send me my receipt" — a paid invoice's link stays copyable (paid state page).
  it('stays visible once the invoice is fully paid', () => {
    render(<InvoiceActions detail={detail({ status: 'paid', amountPaid: '100.00', balance: '0.00' }, { stripeConnected: true })} variant="header" />);
    expect(screen.getByTestId('invoice-pay-link')).toBeInTheDocument();
  });

  it('is hidden on a draft', () => {
    render(<InvoiceActions detail={detail({ status: 'draft', invoiceNumber: null, sentAt: null }, { stripeConnected: true })} variant="header" />);
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
  });

  it('is hidden on a void invoice', () => {
    render(<InvoiceActions detail={detail({ status: 'void' }, { stripeConnected: true })} variant="header" />);
    expect(screen.queryByTestId('invoice-pay-link')).not.toBeInTheDocument();
  });
});
