import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcceptOnBehalfDialog from './AcceptOnBehalfDialog';
import type { Quote, QuoteLine } from './quoteTypes';

// #9256: with no email transport the dialog must not promise the invoice is emailed.

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
const emailFlag = vi.hoisted(() => ({ value: true as boolean | undefined }));
vi.mock('../../../lib/useEmailConfigured', () => ({ useEmailConfigured: () => emailFlag.value }));

const quote = {
  id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', status: 'sent', currencyCode: 'USD',
  oneTimeTotal: '500.00', dueOnAcceptanceTotal: '500.00', billToName: 'Acme Inc.',
} as unknown as Quote;
const lines: QuoteLine[] = [];

function mount(over: { auto?: boolean; recipients?: string[] } = {}) {
  render(<AcceptOnBehalfDialog open onClose={vi.fn()} quote={quote} lines={lines}
    recipients={over.recipients ?? ['it.admin@example.test']}
    autoEmailInvoiceOnAccept={over.auto ?? true} onAccepted={vi.fn()} />);
}

describe('AcceptOnBehalfDialog — email consequence (#9256)', () => {
  beforeEach(() => { emailFlag.value = true; });

  it('promises the email when a transport is configured', () => {
    mount();
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('The invoice will be emailed to it.admin@example.test.');
  });

  it('says the invoice will NOT be emailed when no transport is configured', () => {
    emailFlag.value = false;
    mount();
    const li = screen.getByTestId('accept-on-behalf-consequence-email');
    expect(li).toHaveTextContent('No email service is configured; the invoice will not be emailed. Share it from the invoice page.');
    expect(li).not.toHaveTextContent('will be emailed to');
  });

  it('keeps the default promise while the capability is unknown (not loaded / lookup failed)', () => {
    emailFlag.value = undefined;
    mount();
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('The invoice will be emailed to');
  });

  it('also says so when there is no recorded recipient', () => {
    emailFlag.value = false;
    mount({ recipients: [] });
    expect(screen.getByTestId('accept-on-behalf-consequence-email')).toHaveTextContent('will not be emailed');
  });

  it('renders no email line when auto-email is off, regardless of transport', () => {
    emailFlag.value = false;
    mount({ auto: false });
    expect(screen.queryByTestId('accept-on-behalf-consequence-email')).toBeNull();
  });
});
