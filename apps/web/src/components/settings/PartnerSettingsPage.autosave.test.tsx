import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn(),
  // The header Save gates on partner-wide access (W2).
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const partner = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z', serviceManagementMode: 'native',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {}, address: {} },
};

describe('PartnerSettingsPage card autosave (#9197)', () => {
  it('an ML switch autosave keeps unsaved edits on other tabs and does not refetch the partner', async () => {
    // Stable state object: a fresh adoptPartnerId per render would re-run the fetch effect.
    const state = { currentPartnerId: 'partner-1', isLoading: false, setServiceManagementMode: vi.fn(), adoptPartnerId: vi.fn() };
    useOrgStoreMock.mockImplementation(((selector?: (state: Record<string, unknown>) => unknown) => {
      return selector ? selector(state) : state;
    }) as never);
    fetchWithAuthMock.mockImplementation((async (url: string, init?: RequestInit) => {
      if (url === '/orgs/partners/me' && init?.method === 'PATCH') return json({ data: partner });
      if (url === '/orgs/partners/me') return json(partner);
      return json({ data: [] });
    }) as never);
    const partnerGets = () =>
      fetchWithAuthMock.mock.calls.filter(([u, i]) => u === '/orgs/partners/me' && (!i || !i.method || i.method === 'GET')).length;

    render(<PartnerSettingsPage />);
    await userEvent.click(await screen.findByTestId('partner-settings-tab-company'));
    const name = (await screen.findByLabelText(/company name/i)) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'Edited MSP');
    const getsBefore = partnerGets();

    await userEvent.click(screen.getByTestId('partner-settings-tab-aiFeatures'));
    await userEvent.click(await screen.findByTestId('partner-ml-anomalies-enabled'));
    await waitFor(() =>
      expect(fetchWithAuthMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true),
    );
    await waitFor(() => expect((screen.getByTestId('partner-ml-anomalies-enabled') as HTMLButtonElement).disabled).toBe(false));

    expect(partnerGets()).toBe(getsBefore);
    await userEvent.click(screen.getByTestId('partner-settings-tab-company'));
    expect(((await screen.findByLabelText(/company name/i)) as HTMLInputElement).value).toBe('Edited MSP');
    expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
  });

  describe('W2 Task 23: the autosave switch beside unsaved form edits', () => {
    const state = { currentPartnerId: 'partner-1', isLoading: false, setServiceManagementMode: vi.fn(), adoptPartnerId: vi.fn() };
    let mlPatch: () => Response;
    beforeEach(() => {
      vi.clearAllMocks();
      usePartnerSettingsDraftStore.getState().reset();
      window.location.hash = '';
      useOrgStoreMock.mockImplementation(((selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(state) : state)) as never);
      mlPatch = () => json({ data: partner });
      fetchWithAuthMock.mockImplementation((async (url: string, init?: RequestInit) => {
        if (url === '/orgs/partners/me' && init?.method === 'PATCH') return mlPatch();
        if (url === '/orgs/partners/me') return json(partner);
        return json({ data: [] });
      }) as never);
    });

    const editSecurityThenToggleMl = async () => {
      render(<PartnerSettingsPage />);
      await userEvent.click(await screen.findByTestId('partner-settings-tab-security'));
      const sessions = await screen.findByLabelText('Max Concurrent Sessions');
      await userEvent.type(sessions, '4');
      await userEvent.click(screen.getByTestId('partner-settings-tab-aiFeatures'));
      const ml = await screen.findByTestId('partner-ml-anomalies-enabled');
      expect(ml).toHaveAttribute('role', 'switch');
      await userEvent.click(ml);
    };

    it('ML features render as switches and autosave without touching other drafts', async () => {
      await editSecurityThenToggleMl();
      await waitFor(() => expect(screen.getByTestId('partner-ml-anomalies-enabled')).toBeChecked());
      const patch = fetchWithAuthMock.mock.calls.find(([u, i]) => u === '/orgs/partners/me' && i?.method === 'PATCH')!;
      expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ settings: { ml: { anomalies: { enabled: true, create_alerts: false } } } });
      // The Security draft is still unsaved and unchanged.
      expect(screen.getByTestId('partner-settings-status').textContent).toBe('Unsaved changes in Security.');
      await userEvent.click(screen.getByTestId('partner-settings-tab-security'));
      expect((await screen.findByLabelText('Max Concurrent Sessions') as HTMLInputElement).value).toBe('4');
    });

    it('autosave success shows "Saved · <time>" when nothing else is dirty', async () => {
      render(<PartnerSettingsPage />);
      await userEvent.click(await screen.findByTestId('partner-settings-tab-aiFeatures'));
      await userEvent.click(await screen.findByTestId('partner-ml-anomalies-enabled'));
      await waitFor(() => expect(screen.getByTestId('partner-settings-status').textContent).toMatch(/^Saved · \d/));
    });

    it('autosave failure reverts and shows "Couldn\'t save — try again"', async () => {
      mlPatch = () => ({ ok: false, status: 500, statusText: '', json: vi.fn().mockResolvedValue({ error: 'boom' }) }) as unknown as Response;
      render(<PartnerSettingsPage />);
      await userEvent.click(await screen.findByTestId('partner-settings-tab-aiFeatures'));
      await userEvent.click(await screen.findByTestId('partner-ml-anomalies-enabled'));
      await waitFor(() => expect(screen.getByTestId('partner-settings-status').textContent).toBe("Couldn't save — try again"));
      expect(screen.getByTestId('partner-ml-anomalies-enabled')).not.toBeChecked();
    });
  });
});
