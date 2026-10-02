import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import PaymentsSettingsTab from './PaymentsSettingsTab';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const inherited = {
  autopayOffsetDays: { value: 7, source: 'partner' },
  autopayOffsetRule: { value: 'later', source: 'partner' },
  autopayCap: { value: { enabled: true, amount: '500.00', currency: 'USD' }, source: 'partner' },
  achMode: { value: 'ach_preferred', source: 'default' },
};
const values = { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
  autopayCapAmount: null, autopayCapCurrency: null, achMode: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(
    init?.method === 'PUT' ? { success: true } : { autopayEnabled: true, values, inherited, effective: inherited }));
});
function mount() {
  return render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId="11111111-1111-4111-8111-111111111111" /></I18nextProvider>);
}
it('keeps blank distinct from explicit unlimited and submits decimal cap without floats', async () => {
  mount();
  const days = await screen.findByTestId('autopay-offset-days');
  expect(days).toHaveValue(null);
  expect(days).toHaveAttribute('placeholder', '7');
  fireEvent.change(screen.getByTestId('autopay-cap-enabled'), { target: { value: 'false' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ ...values, autopayCapEnabled: false });
});
it('requires amount and currency together and does not accept exponent money', async () => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1e3' } });
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1000.50' } });
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  expect(screen.getByTestId('autopay-settings-save')).not.toBeDisabled();
});
it('fails closed when autopay is disabled', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ autopayEnabled: false }));
  mount();
  await waitFor(() => expect(screen.queryByTestId('autopay-settings-loading')).toBeNull());
  expect(screen.queryByTestId('autopay-settings')).toBeNull();
});

it('submits the exact decimal string only after valid complete cap terms', async () => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1000.50' } });
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ ...values, autopayCapEnabled: true,
    autopayCapAmount: '1000.50', autopayCapCurrency: 'USD' });
});
