// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { InvoiceLineTable } from './invoicePaper';

afterEach(cleanup);

const DESCRIPTION = 'Final build:\n• Dell R360\n• Windows Server 2025';

describe('InvoiceLineTable line description line breaks (#9401)', () => {
  it('keeps newlines visible in the blurb and the cell wrap rule', () => {
    render(
      <InvoiceLineTable
        currency="USD" taxRate={0} showTax={false}
        lines={[{ ticketNumber: null, name: 'Server build', description: DESCRIPTION, quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: false }]}
      />,
    );
    const blurb = screen.getByText(/Final build:/);
    expect(blurb.className).toContain('whitespace-pre-line');
    expect(blurb.textContent).toBe(DESCRIPTION);
    expect(blurb.closest('td')!.className).toContain('[overflow-wrap:anywhere]');
  });
});
