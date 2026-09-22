// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { InvoiceDetail, InvoiceLine } from '@/lib/api';

// Same stub the other portal component suites use: the real module reaches
// `astro:transitions/client`, which has no resolution outside an Astro build.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import InvoiceDetailView from './InvoiceDetailView';

afterEach(() => cleanup());

// #3319: the customer-facing surface where the dropped line name actually
// showed up. The title/blurb derivation here must stay identical to
// apps/api/src/services/invoicePdf.ts (lineTitle/lineBlurb) so the portal and
// the PDF the same customer downloads label a line the same way.
function line(overrides: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    ticketNumber: null,
    name: null,
    // The API serializes a NULL description as '' (invoiceService's
    // toCustomerInvoiceLine), so '' — not null — is the real absent-blurb shape.
    description: '',
    quantity: '1.00',
    unitPrice: '100.00',
    lineTotal: '100.00',
    taxable: false,
    ...overrides,
  };
}

function detail(lines: InvoiceLine[]): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1',
      invoiceNumber: 'INV-2026-0001',
      status: 'sent',
      currencyCode: 'USD',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      total: '100.00',
      amountPaid: '0.00',
      balance: '100.00',
      depositDue: null,
      subtotal: '100.00',
      taxTotal: '0.00',
      taxRate: null,
      billToName: 'Acme Co',
      notes: null,
    },
    lines,
  };
}

function renderDetail(lines: InvoiceLine[]) {
  return render(<InvoiceDetailView detail={detail(lines)} />);
}

describe('InvoiceDetailView line labels (#3319)', () => {
  it('renders the name as the title and the description as a distinct blurb', () => {
    renderDetail([line({
      name: 'Onboarding & network setup',
      description: 'Network audit, agent deployment, endpoint enrollment',
    })]);

    // Both survive, as separate elements — the whole point of the issue.
    expect(screen.getByText('Onboarding & network setup')).toBeTruthy();
    expect(screen.getByText('Network audit, agent deployment, endpoint enrollment')).toBeTruthy();
  });

  it('falls back to the description as the title for a legacy line with no name', () => {
    renderDetail([line({ name: null, description: 'Legacy widget' })]);

    // Rendered exactly once: as the title, NOT additionally as a blurb.
    expect(screen.getAllByText('Legacy widget')).toHaveLength(1);
  });

  it('renders a name-only line with no blurb', () => {
    renderDetail([line({ name: 'Firewall replacement', description: '' })]);

    expect(screen.getAllByText('Firewall replacement')).toHaveLength(1);
  });

  it('shows a placeholder when the line carries no label at all', () => {
    renderDetail([line({ name: null, description: '' })]);

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders a linked ticket number and omits it for an unlinked line', () => {
    renderDetail([
      line({ ticketNumber: 'T-100' }),
      line({ ticketNumber: null }),
    ]);
    expect(screen.getByTestId('invoice-line-ticket-0').textContent).toBe(
      'Ticket #T-100',
    );
    expect(screen.queryByTestId('invoice-line-ticket-1')).toBeNull();
  });

  it('groups lines under ticket headers with category badge', () => {
    renderDetail([
      line({ ticketNumber: '1042', ticketCategory: 'Hardware', name: 'Work 1' }),
      line({ ticketNumber: '1043', ticketCategory: 'Networking', name: 'Work 2' }),
    ]);
    expect(screen.getAllByText(/Ticket #1042/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Ticket #1043/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Hardware')).toBeTruthy();
    expect(screen.getByText('Networking')).toBeTruthy();
  });

  it('does not render ticket header for lines without ticketNumber', () => {
    renderDetail([
      line({ ticketNumber: null, name: 'Standard Subscription' }),
    ]);
    expect(screen.queryByText(/Ticket #/)).toBeNull();
    expect(screen.getByText('Standard Subscription')).toBeTruthy();
  });
});

// #6467: the worked-vs-billed disclosure is sourced from workedMinutes
// (structured data), never baked into `description` — so an edit to the
// description elsewhere can never erase it here.
describe('InvoiceDetailView worked-vs-billed note (#6467)', () => {
  it('shows the note for a time_entry line whose worked minutes differ from billed', () => {
    renderDetail([line({ description: 'On-site', quantity: '1.00', workedMinutes: 30 })]);
    expect(screen.getByTestId('invoice-line-worked-vs-billed-0')).toHaveTextContent(
      '0.50 h worked · 1.00 h billed',
    );
  });

  it('shows no note when worked minutes equal the billed quantity', () => {
    renderDetail([line({ description: 'Remote', quantity: '1.00', workedMinutes: 60 })]);
    expect(screen.queryByTestId('invoice-line-worked-vs-billed-0')).toBeNull();
  });

  it('shows no note for a non-time-entry line (workedMinutes absent)', () => {
    renderDetail([line({ description: 'Widget', quantity: '2.00' })]);
    expect(screen.queryByTestId('invoice-line-worked-vs-billed-0')).toBeNull();
  });
});

describe('InvoiceDetailView — payment unavailable', () => {
  it('tells the customer what to do next when online payment is switched off (409)', async () => {
    const { portalApi } = await import('@/lib/api');
    vi.spyOn(portalApi, 'payInvoice').mockResolvedValue({ data: null, error: 'Online payment is not available', statusCode: 409 } as never);
    render(<InvoiceDetailView detail={detail([line()])} />);
    fireEvent.click(screen.getByTestId('invoice-pay-button'));
    const alert = await screen.findByTestId('invoice-pay-error');
    expect(alert).toHaveTextContent('Online payment is not available');
    expect(screen.getByTestId('invoice-pay-next-step')).toHaveTextContent(/how to pay this invoice/);
  });
});
