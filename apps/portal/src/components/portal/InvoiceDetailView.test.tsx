// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
