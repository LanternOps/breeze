import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketingSettingsTabs', () => ({ default: () => <div data-testid="stub-ticketing-settings-tabs" /> }));
// The form itself is covered by TrustTemplateSettings.test.tsx; here only the tab wiring.
vi.mock('../trustCenter/TrustTemplateSettings', () => ({ default: () => <div data-testid="stub-trust-template-settings" /> }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro', createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {} },
};
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as unknown as Response);

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation((url: string) => Promise.resolve(url === '/orgs/partners/me' ? json(PARTNER) : json({ data: [] })));
  window.location.hash = '';
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

describe('PartnerSettingsPage — Trust Center tab (W02g)', () => {
  it('lists the tab in the branding group at #trust-center', async () => {
    render(<PartnerSettingsPage />);
    const link = await screen.findByTestId('partner-settings-tab-trustCenter');
    expect(link.getAttribute('href')).toBe('#trust-center');
    expect(link.textContent).toContain('Trust Center');
    expect(link.closest('div')!.textContent).toContain('Login Branding');
  });

  it('mounts the template form from the URL hash as a self-saving tab', async () => {
    window.location.hash = '#trust-center';
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('stub-trust-template-settings')).toBeInTheDocument();
  });
});
