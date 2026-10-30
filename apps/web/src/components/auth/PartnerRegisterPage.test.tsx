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

vi.mock('../../lib/signupOffer', async (orig) => ({
  ...(await orig<typeof import('../../lib/signupOffer')>()),
  fetchSignupOffer: vi.fn(),
}));

import PartnerRegisterPage from './PartnerRegisterPage';
import { fetchSignupOffer } from '../../lib/signupOffer';
import { apiRegisterPartner } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { useFeaturesStore } from '../../stores/featuresStore';

const mockApiRegisterPartner = vi.mocked(apiRegisterPartner);
const mockNavigateTo = vi.mocked(navigateTo);
const mockFetchOffer = vi.mocked(fetchSignupOffer);

const betaOffer = {
  kind: 'cloud_beta' as const, perDevices: 250,
  terms: { monthly: 9900, annual: 100000, two_year: 180000 },
  holdMonths: { monthly: 12, annual: 12, two_year: 24 },
};
const perDeviceOffer = {
  kind: 'cloud_per_device' as const, floorCents: 19900, floorUnder: 50,
  tiers: [[1, 400], [1000, 300], [2500, 250]] as [number, number][],
};

// The page gates on the runtime registration flag (#1308). Seed the store to
// "loaded + enabled" so the form renders; the disabled path has its own test.
function setRegistration(enabled: boolean, loaded = true) {
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false, sendingDomains: false },
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
    window.history.replaceState({}, '', '/register-partner');
    setRegistration(true);
    authState.isAuthenticated = false;
    mockFetchOffer.mockResolvedValue(betaOffer);
  });

  it('shows billing\'s beta quote and submits the cloud intent for a bare URL', async () => {
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'Check email' });
    render(<PartnerRegisterPage />);
    const section = await screen.findByTestId('register-purchase-selection');
    await waitFor(() => expect(section).toHaveTextContent('$99'));
    expect(section).toHaveTextContent('$1,000 a year');
    expect(section).toHaveTextContent('$1,800 for two years');
    expect(section).toHaveTextContent('Price held 12 months (24 on two years)');
    expect(screen.queryByText(/999/)).toBeNull();
    await submitValidForm();
    await waitFor(() => expect(mockApiRegisterPartner).toHaveBeenCalledWith('Acme Co', 'jane@acme.test', 'Sup3rSecure!', 'Jane Doe', { intent: 'cloud' }));
    expect(await screen.findByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login?next=' + encodeURIComponent('/billing/plans?intent=cloud'));
  });

  it('submits the wisp intent and shows the Wisp note', async () => {
    window.history.replaceState({}, '', '/register-partner?intent=wisp&offer=founding');
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'Check email' });
    render(<PartnerRegisterPage />);
    expect(await screen.findByTestId('register-purchase-selection')).toHaveTextContent('Wisp is not open for checkout yet');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=' + encodeURIComponent('/billing/plans?intent=wisp&offer=founding'));
    await submitValidForm();
    await waitFor(() => expect(mockApiRegisterPartner).toHaveBeenCalledWith('Acme Co', 'jane@acme.test', 'Sup3rSecure!', 'Jane Doe', { intent: 'wisp', offer: 'founding' }));
  });

  it('treats a legacy launch URL as the cloud intent with no error panel and no old price', async () => {
    window.history.replaceState({}, '', '/register-partner?catalog=launch-2026-10&capacity=250&billing=monthly');
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'Check email' });
    render(<PartnerRegisterPage />);
    await screen.findByTestId('register-company-name');
    expect(screen.queryByTestId('register-purchase-error')).toBeNull();
    expect(screen.queryByText(/999/)).toBeNull();
    await submitValidForm();
    await waitFor(() => expect(mockApiRegisterPartner).toHaveBeenCalledWith('Acme Co', 'jane@acme.test', 'Sup3rSecure!', 'Jane Doe', { intent: 'cloud' }));
    expect(screen.queryByTestId('register-purchase-error')).toBeNull();
  });

  it('falls back to the cloud intent for an unknown intent value without an error panel', async () => {
    window.history.replaceState({}, '', '/register-partner?intent=hosting');
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'Check email' });
    render(<PartnerRegisterPage />);
    await screen.findByTestId('register-company-name');
    expect(screen.queryByTestId('register-purchase-error')).toBeNull();
    await submitValidForm();
    await waitFor(() => expect(mockApiRegisterPartner).toHaveBeenCalledWith('Acme Co', 'jane@acme.test', 'Sup3rSecure!', 'Jane Doe', { intent: 'cloud' }));
  });

  it('still registers, with no price, when the quote is unavailable', async () => {
    mockFetchOffer.mockResolvedValue(null);
    mockApiRegisterPartner.mockResolvedValue({ success: true, message: 'Check email' });
    render(<PartnerRegisterPage />);
    await screen.findByTestId('register-company-name');
    expect(screen.queryByTestId('register-purchase-selection')).toBeNull();
    await submitValidForm();
    await waitFor(() => expect(mockApiRegisterPartner).toHaveBeenCalled());
  });

  it('keeps the Wisp note when the quote is unavailable', async () => {
    window.history.replaceState({}, '', '/register-partner?intent=wisp');
    mockFetchOffer.mockResolvedValue(null);
    render(<PartnerRegisterPage />);
    expect(await screen.findByTestId('register-wisp-note')).toBeInTheDocument();
  });

  it('shows no Wisp note for the cloud intent', async () => {
    render(<PartnerRegisterPage />);
    await screen.findByTestId('register-purchase-selection');
    expect(screen.queryByTestId('register-wisp-note')).toBeNull();
  });

  it('renders the form while the quote lookup never resolves', async () => {
    mockFetchOffer.mockReturnValue(new Promise(() => {}));
    render(<PartnerRegisterPage />);
    expect(await screen.findByTestId('register-company-name')).toBeInTheDocument();
    expect(screen.queryByTestId('register-purchase-selection')).toBeNull();
  });

  it('sends a signed-in visitor on a legacy launch link to billing plans', async () => {
    window.history.replaceState({}, '', '/register-partner?catalog=launch-2026-10&capacity=250&billing=monthly');
    authState.isAuthenticated = true;
    mockRestoreAccessTokenFromCookieDetailed.mockResolvedValue('restored');
    render(<PartnerRegisterPage />);
    await waitFor(() => expect(mockNavigateTo).toHaveBeenCalledWith('/billing/plans?intent=cloud', { replace: true }));
  });

  it('shows the per-device quote after the beta ends', async () => {
    mockFetchOffer.mockResolvedValue(perDeviceOffer);
    render(<PartnerRegisterPage />);
    const section = await screen.findByTestId('register-purchase-selection');
    await waitFor(() => expect(section).toHaveTextContent('$199'));
    expect(section).toHaveTextContent('$4 a device a month, $3 from 1,000 devices, $2.50 from 2,500 devices. $199 a month minimum under 50 devices.');
    expect(section).not.toHaveTextContent('From 1');
    expect(section).not.toHaveTextContent('$99');
  });

  it('hands an authenticated visitor to normal billing auth with the allowlisted intent', async () => {
    authState.isAuthenticated = true;
    mockRestoreAccessTokenFromCookieDetailed.mockResolvedValue('restored');
    window.history.replaceState({}, '', '/register-partner?intent=cloud&offer=founding&next=https://evil.test');
    render(<PartnerRegisterPage />);
    await waitFor(() => expect(mockNavigateTo).toHaveBeenCalledWith('/billing/plans?intent=cloud&offer=founding', { replace: true }));
    expect(mockApiRegisterPartner).not.toHaveBeenCalled();
  });

  it('preserves the billing destination when registration is disabled at a bare URL', async () => {
    setRegistration(false);
    render(<PartnerRegisterPage />);
    await waitFor(() => expect(mockNavigateTo).toHaveBeenCalledWith('/login?reason=registration-disabled&next=' + encodeURIComponent('/billing/plans?intent=cloud')));
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
