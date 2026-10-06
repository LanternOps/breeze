// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { apiGet, apiPost } from '../../lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); });
const card = { text: 'I authorize future payments.', hash: 'a'.repeat(64), feeText: 'Credit cards have a processing fee of up to 3% of each payment.' };
const bank = { text: 'I authorize bank payments.', hash: 'b'.repeat(64), feeText: 'Each bank payment has a processing fee of $2.50.' };
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/autopay/example');
  vi.mocked(apiGet).mockResolvedValue({ data: { orgId: '11111111-1111-4111-8111-111111111111',
    partnerName: 'Example MSP', orgName: 'Customer', contactEmail: 'billing@example.test', achMode: 'ach_preferred',
    scheduleText: 'On or around the due date.', disclosures: { card, us_bank_account: bank },
    fees: { card: { kind: 'card_percent', feeAmount: '2.00', appliedBps: 200 }, debit: { kind: 'none', feeAmount: '0.00' },
      us_bank_account: { kind: 'ach_flat', feeAmount: '2.50' } },
    consentText: { card: card.text, us_bank_account: bank.text }, consentVersion: 'v1' } } as never);
});
it('renders both method fees in human words and does not mutate on mount', async () => {
  render(<AutopaySetupPage token="example" />);
  expect(await screen.findByTestId('autopay-fee-card')).toHaveTextContent('Credit cards: up to 2% fee');
  expect(screen.getByTestId('autopay-fee-us_bank_account')).toHaveTextContent('$2.50 fee');
  // Bank ($2.50) costs more than a $100 card payment's capped fee ($2.00): not "recommended".
  expect(screen.queryByText(/Recommended/)).toBeNull();
  expect(apiPost).not.toHaveBeenCalled();
});
it('falls back to the disclosure sentence when an older API sends no fee quotes', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', achMode: 'ach_preferred', disclosures: { card, us_bank_account: bank } } } as never);
  render(<AutopaySetupPage token="example" />);
  expect(await screen.findByTestId('autopay-fee-card')).toHaveTextContent(card.feeText);
});
