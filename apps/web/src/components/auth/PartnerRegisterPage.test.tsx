import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stable spy so `expect(mockLogin).not.toHaveBeenCalled()` is meaningful — the
// selector must hand back the SAME login fn on every render, not a fresh one.
const { mockLogin, mockLogout, mockRestoreAccessTokenFromCookieDetailed, authState } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockLogout: vi.fn(),
  mockRestoreAccessTokenFromCookieDetailed: vi.fn(),
  // Mutated per-test to drive the sweep paper cut #1 already-signed-in check.
  authState: { isAuthenticated: false },
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn>; isAuthenticated: boolean }) => unknown) =>
      selector({ login: mockLogin, isAuthenticated: authState.isAuthenticated }),
    { getState: () => ({ login: mockLogin, logout: mockLogout, isAuthenticated: authState.isAuthenticated }) },
  ),
  restoreAccessTokenFromCookieDetailed: mockRestoreAccessTokenFromCookieDetailed,
  apiRegisterPartner: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

import PartnerRegisterPage from './PartnerRegisterPage';
import { apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { useFeaturesStore } from '../../stores/featuresStore';

const mockApiRegisterPartner = vi.mocked(apiRegisterPartner);
const mockNavigateTo = vi.mocked(navigateTo);

// The page gates on the runtime registration flag (#1308). Seed the store to
// "loaded + enabled" so the form renders; the disabled path has its own test.
function setRegistration(enabled: boolean, loaded = true) {
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false },
    cfAccessLogin: { enabled: false },
    registration: { enabled },
    loaded,
  });
}

async function submitValidForm() {
  fireEvent.input(screen.getByLabelText(/company name/i), { target: { value: 'Acme Co' } });
  fireEvent.input(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.input(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.test' } });
  fireEvent.input(screen.getAllByLabelText(/^password$/i)[0]!, { target: { value: 'Sup3rSecure!' } });
  fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'Sup3rSecure!' } });
  fireEvent.click(screen.getByLabelText(/I agree/i));
  fireEvent.click(screen.getByRole('button', { name: /create company account/i }));
}

describe('PartnerRegisterPage — SR2-21 email-first signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRegistration(true);
    authState.isAuthenticated = false;
  });

  // Sweep paper cut #1: this bare Astro page is reached by a full-page nav,
  // so an already-signed-in visitor has a persisted `isAuthenticated` flag
  // but no in-memory token. The page must resolve that with its OWN
  // cookie-refresh check before ever letting the registration gate's /config
  // call race the same condition inside fetchWithAuth — which used to end in
  // a wrong, confusing /login?reason=session-expired bounce for a valid session.
  describe('already-signed-in visitor (#1)', () => {
    beforeEach(() => {
      authState.isAuthenticated = true;
    });

    it('sends a genuinely valid session to the dashboard, never to /login', async () => {
      mockRestoreAccessTokenFromCookieDetailed.mockResolvedValue('restored');
      render(<PartnerRegisterPage />);

      await waitFor(() => expect(mockNavigateTo).toHaveBeenCalledWith('/dashboard', { replace: true }));
      expect(mockNavigateTo).not.toHaveBeenCalledWith(expect.stringContaining('/login'));
      expect(screen.queryByLabelText(/company name/i)).toBeNull();
    });

    it('does not evict a valid session on a transient refresh failure (502/offline)', async () => {
      mockRestoreAccessTokenFromCookieDetailed.mockResolvedValue('transient');
      render(<PartnerRegisterPage />);

      await screen.findByLabelText(/company name/i);
      expect(mockLogout).not.toHaveBeenCalled();
      expect(mockNavigateTo).not.toHaveBeenCalledWith(expect.stringContaining('session-expired'));
    });

    it('clears a merely stale flag and shows the registration form instead of bouncing to /login?reason=session-expired', async () => {
      mockRestoreAccessTokenFromCookieDetailed.mockResolvedValue('auth-failed');
      render(<PartnerRegisterPage />);

      await screen.findByLabelText(/company name/i);
      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(mockNavigateTo).not.toHaveBeenCalledWith(expect.stringContaining('session-expired'));
    });
  });

  it('redirects to login when registration is disabled at runtime (#1308)', async () => {
    setRegistration(false);
    render(<PartnerRegisterPage />);
    await waitFor(() =>
      expect(navigateTo).toHaveBeenCalledWith('/login?reason=registration-disabled'),
    );
    expect(screen.queryByLabelText(/company name/i)).toBeNull();
  });

  it('SR2-21: a successful signup shows "check your email" and does NOT log the user in', async () => {
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
    render(<PartnerRegisterPage />);
    await submitValidForm();
    expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  it('shows the same "check your email" panel for an address that already has an account', async () => {
    // Same server response — the UI must not branch on it either (anti-enumeration).
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'If registration can proceed…' });
    render(<PartnerRegisterPage />);
    await submitValidForm();
    expect(await screen.findByTestId('register-check-email')).toBeInTheDocument();
  });

  it('renders the recovery link when a rejection carries one (BUSINESS_EMAIL_REQUIRED)', async () => {
    // The copy tells the user to schedule a call, so the link has to be
    // clickable — a rejection that only prints the sentence is a dead end.
    mockApiRegisterPartner.mockResolvedValue({
      success: false,
      error: 'Please sign up with your business email address.',
      action: { url: 'https://breezermm.com/contact', label: 'Schedule a call' },
    });
    render(<PartnerRegisterPage />);
    await submitValidForm();

    const link = await screen.findByTestId('register-error-action');
    expect(link).toHaveAttribute('href', 'https://breezermm.com/contact');
    expect(link).toHaveTextContent('Schedule a call');
  });

  it('renders a plain rejection with no link when the server offers no next step', async () => {
    mockApiRegisterPartner.mockResolvedValue({ success: false, error: 'Registration failed' });
    render(<PartnerRegisterPage />);
    await submitValidForm();

    expect(await screen.findByText('Registration failed')).toBeInTheDocument();
    expect(screen.queryByTestId('register-error-action')).toBeNull();
  });
});
