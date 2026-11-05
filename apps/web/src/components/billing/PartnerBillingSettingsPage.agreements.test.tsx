import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

import PartnerBillingSettingsPage from './PartnerBillingSettingsPage';
import { fetchWithAuth } from '../../stores/auth';

// #9075 W4a (OD8 B): Settings → Billing → Agreements — default expiry and the
// automatic-reminder cadence, saved by the page's one Save button.

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) => sel({ user: { canManagePartnerWide: true } }),
}));
let canWrite = true;
let canSendAgreements = true;
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) =>
      resource === 'agreements' && action === 'send' ? canSendAgreements : canWrite,
  }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PARTNER = { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 };

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
}

async function gotoAgreements() {
  const visible = screen.queryByTestId('billing-settings-tab-agreements');
  if (visible?.getAttribute('role') !== 'tab') {
    await userEvent.click(await screen.findByTestId('billing-settings-tab-more'));
  }
  await userEvent.click(await screen.findByTestId('billing-settings-tab-agreements'));
  return screen.findByTestId('agreements-settings');
}

function patchBody(): Record<string, unknown> | null {
  const call = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  canWrite = true;
  canSendAgreements = true;
  window.location.hash = '';
});

describe('Billing → Agreements settings tab (#9075 W4a)', () => {
  it('reads the partner values back: expiry, reminders on, interval and cap', async () => {
    fetchMock.mockResolvedValue(json({ ...PARTNER, agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: 3, agreementMaxReminders: 2 }));
    renderPage();
    await gotoAgreements();
    expect(window.location.hash).toBe('#agreements');
    expect(screen.getByTestId('agreements-settings-expiry-days')).toHaveValue(14);
    expect(screen.getByTestId('agreements-settings-reminders-enabled')).toBeChecked();
    expect(screen.getByTestId('agreements-settings-interval-days')).toHaveValue(3);
    expect(screen.getByTestId('agreements-settings-max-reminders')).toHaveValue(2);
  });

  it('an API without the fields shows the built-in defaults (30 days, reminders off) and hides the cadence inputs', async () => {
    fetchMock.mockResolvedValue(json(PARTNER));
    renderPage();
    await gotoAgreements();
    expect(screen.getByTestId('agreements-settings-expiry-days')).toHaveValue(30);
    expect(screen.getByTestId('agreements-settings-reminders-enabled')).not.toBeChecked();
    expect(screen.queryByTestId('agreements-settings-interval-days')).not.toBeInTheDocument();
  });

  it('the page Save sends the agreement fields; switching reminders on sends the interval and cap', async () => {
    fetchMock.mockResolvedValue(json(PARTNER));
    renderPage();
    await gotoAgreements();
    fireEvent.change(screen.getByTestId('agreements-settings-expiry-days'), { target: { value: '21' } });
    await userEvent.click(screen.getByTestId('agreements-settings-reminders-enabled'));
    fireEvent.change(screen.getByTestId('agreements-settings-interval-days'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('agreements-settings-max-reminders'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toMatchObject({ ...PARTNER, agreementDefaultExpiryDays: 21, agreementReminderIntervalDays: 5, agreementMaxReminders: 4 });
  });

  it('switching reminders off saves a null interval (keeps the cap)', async () => {
    fetchMock.mockResolvedValue(json({ ...PARTNER, agreementDefaultExpiryDays: 30, agreementReminderIntervalDays: 3, agreementMaxReminders: 2 }));
    renderPage();
    await gotoAgreements();
    await userEvent.click(screen.getByTestId('agreements-settings-reminders-enabled'));
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toMatchObject({ agreementDefaultExpiryDays: 30, agreementReminderIntervalDays: null, agreementMaxReminders: 2 });
  });

  it.each([
    ['agreements-settings-expiry-days', '0', 'agreements-settings-expiry-days-error'],
    ['agreements-settings-expiry-days', '366', 'agreements-settings-expiry-days-error'],
    ['agreements-settings-interval-days', '31', 'agreements-settings-interval-days-error'],
    ['agreements-settings-max-reminders', '11', 'agreements-settings-max-reminders-error'],
  ])('%s = %s is flagged inline and never sent', async (field, value, errorId) => {
    fetchMock.mockResolvedValue(json({ ...PARTNER, agreementReminderIntervalDays: 3, agreementMaxReminders: 2 }));
    renderPage();
    await gotoAgreements();
    fireEvent.change(screen.getByTestId(field), { target: { value } });
    expect(await screen.findByTestId(errorId)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await new Promise((r) => setTimeout(r, 20));
    expect(patchBody()).toBeNull();
    // The save lands the user on the tab that holds the problem.
    expect(window.location.hash).toBe('#agreements');
  });

  it('without agreements:send the tab is read-only and the save omits every agreement field', async () => {
    canSendAgreements = false;
    fetchMock.mockResolvedValue(json({ ...PARTNER, agreementDefaultExpiryDays: 14, agreementReminderIntervalDays: 3, agreementMaxReminders: 2 }));
    renderPage();
    await gotoAgreements();
    expect(screen.getByTestId('agreements-settings-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('agreements-settings-expiry-days')).toBeDisabled();
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => expect(patchBody()).not.toBeNull());
    const body = patchBody()!;
    for (const key of ['agreementDefaultExpiryDays', 'agreementReminderIntervalDays', 'agreementMaxReminders']) {
      expect(body).not.toHaveProperty(key);
    }
  });
});
