import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../../stores/auth';
import AcceptOnBehalfDialog from './AcceptOnBehalfDialog';
import type { Quote, QuoteLine } from './quoteTypes';

// #9256: with no email transport the dialog must not promise the invoice is emailed.

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

const quote = {
  id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', status: 'sent', currencyCode: 'USD',
  oneTimeTotal: '500.00', dueOnAcceptanceTotal: '500.00', billToName: 'Acme Inc.',
} as unknown as Quote;
const lines: QuoteLine[] = [];

function mount(over: { auto?: boolean; recipients?: string[]; emailConfigured?: boolean } = {}) {
  render(<AcceptOnBehalfDialog open onClose={vi.fn()} quote={quote} lines={lines}
    recipients={over.recipients ?? ['it.admin@example.test']}
    autoEmailInvoiceOnAccept={over.auto ?? true} emailConfigured={over.emailConfigured} onAccepted={vi.fn()} />);
}

describe('AcceptOnBehalfDialog — email consequence (#9256)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('promises the email when a transport is configured', () => {
    mount({ emailConfigured: true });
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('The invoice will be emailed to it.admin@example.test.');
  });

  it('says the invoice will NOT be emailed when no transport is configured', () => {
    mount({ emailConfigured: false });
    const li = screen.getByTestId('accept-on-behalf-consequence-email');
    expect(li).toHaveTextContent('No email service is configured; the invoice will not be emailed. Share it from the invoice page.');
    expect(li).not.toHaveTextContent('will be emailed to');
  });

  it('keeps the default promise and fetches nothing while the flag is unknown (omitted from the payload)', () => {
    mount();
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('The invoice will be emailed to');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('also says so when there is no recorded recipient', () => {
    mount({ recipients: [], emailConfigured: false });
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('will not be emailed');
  });

  it('renders no email line when auto-email is off, regardless of transport', () => {
    mount({ auto: false, emailConfigured: false });
    expect(screen.queryByTestId('accept-on-behalf-consequence-email')).toBeNull();
  });
});
