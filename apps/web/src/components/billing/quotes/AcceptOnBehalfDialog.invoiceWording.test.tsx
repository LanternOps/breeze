import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcceptOnBehalfDialog from './AcceptOnBehalfDialog';
import type { Quote, QuoteLine } from './quoteTypes';

// Sweep G10: a recurring-only quote leaves the invoice as an unnumbered draft,
// so the consequences list must not claim it is "issued and numbered now".

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

const quote = {
  id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', status: 'sent', currencyCode: 'USD',
  oneTimeTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme Inc.',
} as unknown as Quote;

const line = (recurrence: string) => ({ id: `l-${recurrence}`, recurrence }) as unknown as QuoteLine;

function mount(lines: QuoteLine[]) {
  render(<AcceptOnBehalfDialog open onClose={vi.fn()} quote={quote} lines={lines}
    recipients={['it.admin@example.test']} autoEmailInvoiceOnAccept={false} onAccepted={vi.fn()} />);
}

describe('AcceptOnBehalfDialog — invoice consequence wording', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses draft wording for a recurring-only quote', () => {
    mount([line('monthly')]);
    const li = screen.getByTestId('accept-on-behalf-consequence-invoice');
    expect(li).toHaveTextContent(/draft/i);
    expect(li).not.toHaveTextContent('issued and numbered');
  });

  it('keeps issued-and-numbered wording when the quote has one-time lines', () => {
    mount([line('one_time'), line('monthly')]);
    expect(screen.getByTestId('accept-on-behalf-consequence-invoice')).toHaveTextContent('issued and numbered now');
  });
});
