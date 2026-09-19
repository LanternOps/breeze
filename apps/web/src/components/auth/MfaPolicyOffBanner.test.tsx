import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MfaPolicyOffBanner, { PARTNER_SETTINGS_SAVED_EVENT } from './MfaPolicyOffBanner';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

type BannerUser = { id: string; canManagePartnerWide?: boolean } | null;
type Scope = 'system' | 'partner' | 'organization' | null;

const state = vi.hoisted(() => ({
  user: null as BannerUser,
  claims: { status: 'resolved', claims: { scope: 'partner' as Scope, orgId: null, partnerId: 'p1' } } as
    | { status: 'unresolved' }
    | { status: 'resolved'; claims: { scope: Scope; orgId: string | null; partnerId: string | null } },
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: BannerUser }) => unknown) => {
      const s = { user: state.user };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: state.user }) },
  ),
}));

vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => state.claims,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const DISMISS_KEY = 'breeze.mfaPolicyOffBannerDismissedOn';
const TEST_ID = 'mfa-policy-off-banner';

const partnerResponse = (requireMfa: boolean | undefined): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'p1',
      name: 'Acme MSP',
      settings: requireMfa === undefined ? {} : { security: { requireMfa } },
    }),
  }) as unknown as Response;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  state.user = { id: 'user-1', canManagePartnerWide: true };
  state.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } };
  fetchWithAuthMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('MfaPolicyOffBanner', () => {
  it('renders for a partner policy-manager whose partner has requireMfa absent', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(undefined));

    render(<MfaPolicyOffBanner />);

    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me');
    expect(screen.getByText('mfaPolicyOffBanner.message')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'mfaPolicyOffBanner.cta' })).toHaveAttribute(
      'href',
      '/settings/partner#security',
    );
  });

  it('renders when requireMfa is explicitly false', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
  });

  it('renders nothing when requireMfa is true', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(true));
    render(<MfaPolicyOffBanner />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing (and never fetches) for an organization-scoped session', async () => {
    state.claims = { status: 'resolved', claims: { scope: 'organization', orgId: 'o1', partnerId: 'p1' } };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing (and never fetches) while the scope is still unresolved', async () => {
    state.claims = { status: 'unresolved' };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing (and never fetches) for a partner user who cannot manage partner-wide policies', async () => {
    state.user = { id: 'user-1', canManagePartnerWide: false };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing when there is no authenticated user', async () => {
    state.user = null;
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the fetch fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response);
    render(<MfaPolicyOffBanner />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it("dismisses for the day and writes today's date to localStorage", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    await screen.findByTestId(TEST_ID);

    fireEvent.click(screen.getByLabelText('mfaPolicyOffBanner.dismiss'));

    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe(todayKey());
  });

  it('stays hidden for the rest of the day once dismissed today', async () => {
    window.localStorage.setItem(DISMISS_KEY, todayKey());
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('comes back when the stored dismissal date is stale (yesterday)', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    window.localStorage.setItem(
      DISMISS_KEY,
      `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`,
    );
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
  });

  it('re-checks and hides after the partner settings page reports a save that turned MFA on', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(partnerResponse(false))
      .mockResolvedValueOnce(partnerResponse(true));
    render(<MfaPolicyOffBanner />);
    await screen.findByTestId(TEST_ID);

    act(() => {
      window.dispatchEvent(new Event(PARTNER_SETTINGS_SAVED_EVENT));
    });

    await waitFor(() => expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument());
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });
});
