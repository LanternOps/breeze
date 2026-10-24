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
vi.mock('./KnownGuestsSettings', () => ({ default: () => <div data-testid="stub-known-guests" /> }));
vi.mock('../callerVerification/CallerVerificationPolicyForm', () => ({
  PartnerCallerVerificationPolicy: () => <div data-testid="stub-caller-verification-policy" />,
}));

// Flag state is mutable so a test can model "unresolved" (loaded=false) and then "settled".
const flag = vi.hoisted(() => ({ enabled: false, loaded: false }));
vi.mock('../../lib/useCallerVerificationEnabled', () => ({
  useCallerVerificationEnabled: () => flag.loaded && flag.enabled,
}));
vi.mock('../../stores/featuresStore', () => ({
  useFeaturesStore: (sel: (s: { loaded: boolean }) => unknown) => sel({ loaded: flag.loaded }),
}));

const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {}, address: {} },
};
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: 'OK', json: async () => body }) as unknown as Response;

beforeEach(() => {
  flag.enabled = false;
  flag.loaded = false;
  window.location.hash = '';
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url === '/orgs/partners/me') return json(PARTNER);
    return json({ data: [] });
  });
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

const panelHeading = () => screen.getByTestId('partner-settings-panel-heading').textContent;

describe('PartnerSettingsPage — Known guests and Caller verification tabs (#9787)', () => {
  it('#known-guests renders Known guests and Regional no longer does', async () => {
    window.location.hash = '#known-guests';
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('stub-known-guests')).toBeInTheDocument();
    expect(screen.getByTestId('partner-settings-tab-knownGuests')).toHaveAttribute('aria-current', 'page');

    window.location.hash = '#regional';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByLabelText('Language')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-known-guests')).toBeNull();
  });

  it('#caller-verification renders the policy form when the flag is on', async () => {
    flag.enabled = true;
    flag.loaded = true;
    window.location.hash = '#caller-verification';
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('stub-caller-verification-policy')).toBeInTheDocument();
    expect(screen.getByTestId('partner-settings-tab-callerVerification')).toHaveAttribute('aria-current', 'page');
  });

  it('#caller-verification does not fall back while the flag is unresolved, then falls back to Security once it settles off', async () => {
    window.location.hash = '#caller-verification';
    const { rerender } = render(<PartnerSettingsPage />);
    await screen.findByTestId('partner-settings-panel-heading');
    // Unresolved (loaded=false): the bookmark must hold.
    expect(screen.getByTestId('stub-caller-verification-policy')).toBeInTheDocument();

    flag.loaded = true; // settled, flag off
    rerender(<PartnerSettingsPage />);
    expect(await screen.findByTestId('partner-settings-tab-security')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('stub-caller-verification-policy')).toBeNull();
    expect(screen.queryByTestId('partner-settings-tab-callerVerification')).toBeNull();
  });

  it('Security no longer renders the caller verification form', async () => {
    flag.enabled = true;
    flag.loaded = true;
    window.location.hash = '#security';
    render(<PartnerSettingsPage />);
    await screen.findByTestId('partner-settings-panel-heading');
    expect(panelHeading()).toBe('Security');
    expect(screen.queryByTestId('stub-caller-verification-policy')).toBeNull();
  });

  it('rail lists Caller verification when the flag is on', async () => {
    flag.enabled = true;
    flag.loaded = true;
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('partner-settings-tab-callerVerification')).toHaveAttribute('href', '#caller-verification');
  });
});
