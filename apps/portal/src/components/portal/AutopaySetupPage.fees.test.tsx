// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { apiGet, apiPost } from '../../lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('../../lib/api', () => ({ apiGet:vi.fn(), apiPost:vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); });
const card = { text:'I authorize future payments.', hash:'a'.repeat(64), feeText:'Credit card: up to 3.00%. Debit, prepaid and unknown-funding cards have no fee.' };
const bank = { text:'I authorize bank payments.', hash:'b'.repeat(64), feeText:'Each bank payment includes a $2.50 processing fee.' };
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/autopay/example');
  vi.mocked(apiGet).mockResolvedValue({ data:{ orgId:'11111111-1111-4111-8111-111111111111',
    partnerName:'Example MSP', orgName:'Customer', contactEmail:'billing@example.test', achMode:'ach_preferred',
    scheduleText:'On or around the due date.', disclosures:{card,us_bank_account:bank},
    consentText:{card:card.text,us_bank_account:bank.text}, consentVersion:'v1' } } as never);
});
it('renders both method fees through the setup page and does not mutate on mount', async () => {
  render(<AutopaySetupPage token="example" />);
  expect(await screen.findByTestId('autopay-fee-card')).toHaveTextContent('3.00%');
  expect(screen.getByTestId('autopay-fee-us_bank_account')).toHaveTextContent('$2.50');
  expect(apiPost).not.toHaveBeenCalled();
});
it('renders verified debit zero fee after explicit return confirmation', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_test');
  sessionStorage.setItem('autopay-return-token','example');
  vi.mocked(apiPost).mockResolvedValue({data:{outcome:'activated',orgId:'11111111-1111-4111-8111-111111111111',
    methodLabel:'Visa debit ••1234',feeText:'No processing fee applies to this card.'}} as never);
  render(<AutopaySetupPage token="example" mode="return" />);
  fireEvent.click(await screen.findByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('No processing fee applies to this card.');
  expect(screen.getByTestId('autopay-return-fee')).toHaveTextContent('No processing fee applies to this card.');
});
