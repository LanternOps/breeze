import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {}, address: {} },
};

function mountPage() {
  useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(PARTNER));
  return render(<PartnerSettingsPage />);
}

describe('PartnerSettingsPage Ticketing rail link (#9787)', () => {
  beforeEach(() => { window.location.hash = ''; });

  it('rail shows Ticketing as a link to /settings/ticketing', async () => {
    mountPage();
    const link = await screen.findByTestId('partner-settings-tab-ticketing');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/settings/ticketing');
    expect(link).not.toHaveAttribute('aria-current');
    expect(screen.queryByTestId('ticketing-settings-tabs')).not.toBeInTheDocument();
  });

  it('#ticketing still renders the static link-out panel and does not navigate', async () => {
    window.location.hash = '#ticketing';
    const assign = vi.fn();
    const replace = vi.fn();
    const hrefSet = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, hash: '#ticketing', assign, replace, set href(v: string) { hrefSet(v); }, addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window) } });
    try {
      mountPage();
      expect(await screen.findByTestId('partner-settings-ticketing-panel')).toBeInTheDocument();
      expect(screen.getByTestId('partner-settings-ticketing-link')).toHaveAttribute('href', '/settings/ticketing');
      expect(assign).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(hrefSet).not.toHaveBeenCalled();
      expect(vi.mocked(navigateTo)).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
