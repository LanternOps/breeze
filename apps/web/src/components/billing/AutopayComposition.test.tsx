import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PartnerBillingSettingsPage from './PartnerBillingSettingsPage';
import OrgBillingSettings from './OrgBillingSettings';
import { fetchWithAuth } from '../../stores/auth';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(),useAuthStore:(select:any)=>select({user:{canManagePartnerWide:true}}) }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./BillingRatesTab', () => ({ default: () => null }));
vi.mock('./BillingConnectionsTab', () => ({ default: () => null }));
const resolved = {
  remindersEnabled: { value: false, source: 'default' },
  reminderBeforeDueDays: { value: 3, source: 'default' },
  reminderRepeatDays: { value: null, source: 'default' },
  overdueReminderEveryDays: { value: 7, source: 'default' },
 autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
  autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' } };
beforeEach(() => {
  window.location.hash = ''; vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async url => Response.json(String(url).endsWith('/payment-settings') ? {
    autopayEnabled: true, inherited: resolved, effective: resolved,
    values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null },
  } : String(url).endsWith('/autopay') ? { orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example', status: 'not_requested', billingContact: null, enrollment: null, method: null }
  : { currencyCode: 'USD', invoiceTermsDays: 30, billingContact: null, taxExempt: false, data: [] }));
});
it('mounts Payments on its exact hash and removes the other page Save', async () => {
  window.location.hash = 'payments'; render(<PartnerBillingSettingsPage />);
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(screen.queryByTestId('partner-billing-save')).toBeNull();
});
it('mounts org settings and enrollment card in the existing org Billing page', async () => {
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-org-card')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-save')).toBeNull();
  expect(screen.getByTestId('org-billing-save')).toBeInTheDocument();
});

it('gives the new Payments tab an autopay-prefixed interactive test id', async () => {
  render(<PartnerBillingSettingsPage />);
  await screen.findByTestId('partner-billing-settings');
  if (!screen.queryByTestId('autopay-payments-tab')) {
    fireEvent.click(await screen.findByTestId('billing-settings-tab-more'));
  }
  expect(await screen.findByTestId('autopay-payments-tab')).toBeInTheDocument();
});
