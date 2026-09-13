import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MfaEnrollmentGraceBanner from './MfaEnrollmentGraceBanner';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { date?: string }) =>
      options?.date != null ? `${key}:${options.date}` : key,
    i18n: { language: 'en' },
  }),
}));

type MfaUser = { id: string; mfaEnabled: boolean } | null;

const state = vi.hoisted(() => ({ user: null as MfaUser }));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: MfaUser }) => unknown) => {
      const s = { user: state.user };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: state.user }) },
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const DISMISS_KEY = 'breeze.mfaGraceBannerDismissedOn';

const optionsResponse = (mfaGraceEndsAt: string | null): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      allowedMethods: { totp: true, sms: false, passkey: true },
      phoneConfigured: false,
      mfaEnrollmentRequired: true,
      mfaGraceEndsAt,
    }),
  }) as unknown as Response;

const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  state.user = { id: 'user-1', mfaEnabled: false };
  fetchWithAuthMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('MfaEnrollmentGraceBanner', () => {
  it('renders the deadline when inside the grace window', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(FUTURE));

    render(<MfaEnrollmentGraceBanner />);

    expect(await screen.findByTestId('mfa-enrollment-grace-banner')).toBeInTheDocument();
    expect(screen.getByText(/mfaEnrollmentGraceBanner\.message:/)).toBeInTheDocument();
    expect(screen.getByText('mfaEnrollmentGraceBanner.cta')).toHaveAttribute('href', '/auth/mfa/setup');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/auth/mfa/enrollment-options');
  });

  it('renders nothing when mfaGraceEndsAt is null', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(null));

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the grace deadline is already in the past', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(PAST));

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing (and never fetches) when user.mfaEnabled is true', async () => {
    state.user = { id: 'user-1', mfaEnabled: true };

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing when there is no authenticated user', async () => {
    state.user = null;

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the fetch fails', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('network error'));

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('dismisses the banner and writes today\'s date to localStorage', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(FUTURE));

    render(<MfaEnrollmentGraceBanner />);

    await screen.findByTestId('mfa-enrollment-grace-banner');
    fireEvent.click(screen.getByLabelText('mfaEnrollmentGraceBanner.dismiss'));

    expect(screen.queryByTestId('mfa-enrollment-grace-banner')).not.toBeInTheDocument();
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const day = String(new Date().getDate()).padStart(2, '0');
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe(`${year}-${month}-${day}`);
  });

  it('does not suppress the banner when the stored dismissal date is stale (yesterday)', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getDate()).padStart(2, '0');
    window.localStorage.setItem(DISMISS_KEY, `${y}-${m}-${d}`);

    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(FUTURE));

    render(<MfaEnrollmentGraceBanner />);

    expect(await screen.findByTestId('mfa-enrollment-grace-banner')).toBeInTheDocument();
  });

  it('stays hidden for the rest of the day once dismissed today', async () => {
    const key = (() => {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    })();
    window.localStorage.setItem(DISMISS_KEY, key);
    fetchWithAuthMock.mockResolvedValueOnce(optionsResponse(FUTURE));

    const { container } = render(<MfaEnrollmentGraceBanner />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
