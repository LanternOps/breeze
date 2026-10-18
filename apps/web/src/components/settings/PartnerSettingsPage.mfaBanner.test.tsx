import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({
  PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved',
  default: ({ placement }: { placement?: string }) => (
    <aside data-testid="mfa-policy-off-banner" data-placement={placement} />
  ),
}));

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const makeJsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('PartnerSettingsPage MFA banner placement (#9171)', () => {
  it('mounts the page-placed banner inside the container, directly below the header', async () => {
    vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
    vi.mocked(fetchWithAuth).mockResolvedValue(makeJsonResponse({ data: [] }));
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z',
        settings: { timezone: 'UTC', contact: {}, address: {} },
      })
    );

    render(<PartnerSettingsPage />);
    const banner = await screen.findByTestId('mfa-policy-off-banner');
    expect(banner).toHaveAttribute('data-placement', 'page');
    const header = screen.getByRole('heading', { level: 1 }).closest('header');
    expect(header).not.toBeNull();
    expect(banner.previousElementSibling).toBe(header);
    expect(banner.parentElement).toBe(header?.parentElement);
  });
});
