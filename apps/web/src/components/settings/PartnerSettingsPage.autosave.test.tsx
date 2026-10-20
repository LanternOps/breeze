import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const partner = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z', serviceManagementMode: 'native',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {}, address: {} },
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
    await waitFor(() => expect((screen.getByTestId('partner-ml-anomalies-enabled') as HTMLInputElement).disabled).toBe(false));

    expect(partnerGets()).toBe(getsBefore);
    await userEvent.click(screen.getByTestId('partner-settings-tab-company'));
    expect(((await screen.findByLabelText(/company name/i)) as HTMLInputElement).value).toBe('Edited MSP');
    expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
  });
});
