import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) =>
      selector({ login: vi.fn() }),
    {},
  ),
  apiLogin: vi.fn(),
  apiVerifyMFA: vi.fn(),
  apiVerifyPasskeyMFA: vi.fn(),
  apiSendSmsMfaCode: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
  // LoginForm's useRegistrationGate loads /config via fetchWithAuth; answer
  // "registration disabled" so the password form renders unchanged.
  fetchWithAuth: vi.fn(async () => new Response('{}', { status: 200 })),
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

// Partner SSO button (#2183): LoginPage reads the memoized login context to
// decide whether to surface a "Sign in with {provider}" button. Default to the
// empty shape so existing password-form tests are unaffected.
vi.mock('../../lib/loginContext', () => ({
  getLoginContext: vi.fn(async () => ({ branding: null, partnerSso: null })),
}));

// LoginPage now fetches /api/v1/config at mount to decide whether to redirect
// the browser to the Cloudflare Access login endpoint. The default mock here
// answers "feature disabled" so the existing happy-path tests render the
// password form unchanged.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ cfAccessLogin: { enabled: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  );
});

import LoginPage from './LoginPage';
import { apiLogin, apiVerifyMFA } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { getLoginContext } from '../../lib/loginContext';

const baseLoginSuccess = {
  success: true,
  user: { id: 'u1', email: 'jane@example.com', name: 'Jane', mfaEnabled: false },
  tokens: { accessToken: 'a', refreshToken: 'r', expiresInSeconds: 900 },
  requiresSetup: false,
};

async function fillAndSubmit(email = 'jane@example.com', password = 'Sup3rSecure!') {
  // The config-check effect resolves on a microtask after mount; wait for the
  // form to appear before driving it.
  await waitFor(() => screen.getByLabelText(/email/i));
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage hydration safety', () => {
  // Regression for React #418 on /login: the initial render must NOT depend on
  // `typeof window` (or any window-only signal), or the server render (no
  // window) and the client's first render disagree and React tears the tree
  // down. `cfAccessRedirectChecked`'s initial value used to be
  // `shouldSkipCfAccessRedirect()`, which returns true on the server (renders
  // the form) and false on a plain client load (renders the placeholder).
  it('renders identically with and without `window` (no SSR/CSR divergence)', async () => {
    const { renderToString } = await import('react-dom/server');

    const clientHtml = renderToString(<LoginPage />);

    const realWindow = globalThis.window;
    // Simulate the server environment where `window` is undefined.
    // @ts-expect-error intentionally removing the global for this assertion
    delete globalThis.window;
    let serverHtml: string;
    try {
      serverHtml = renderToString(<LoginPage />);
    } finally {
      globalThis.window = realWindow;
    }

    expect(serverHtml).toBe(clientHtml);
  });
});

describe('LoginPage navigation after login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to next when login succeeds and setup is complete', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  it('navigates to "/" when next is omitted', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });

  it('routes to /setup when requiresSetup is true, ignoring next', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce({ ...baseLoginSuccess, requiresSetup: true });
    render(<LoginPage next="/oauth/consent?uid=abc" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/setup');
  });

  it('rewrites unsafe next to "/" before navigating', async () => {
    vi.mocked(apiLogin).mockResolvedValueOnce(baseLoginSuccess);
    render(<LoginPage next="https://evil.example.com" />);

    await fillAndSubmit();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});

describe('LoginPage partner SSO button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default empty-context resolution cleared above.
    vi.mocked(getLoginContext).mockResolvedValue({ branding: null, partnerSso: null });
  });

  it('renders a "Sign in with {provider}" button when partner SSO is available', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
    });

    render(<LoginPage />);

    const btn = await screen.findByTestId('partner-sso-button');
    expect(btn).toHaveTextContent('Sign in with Okta');
    // safeNext defaults to '/', so the redirect param is always appended.
    expect(btn.getAttribute('href')).toBe('/api/v1/sso/login/partner/p1?redirect=%2F');
    // Password form remains visible.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('appends the safe next as a redirect param on the SSO button href', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
    });

    render(<LoginPage next="/devices" />);

    const btn = await screen.findByTestId('partner-sso-button');
    expect(btn.getAttribute('href')).toBe(
      '/api/v1/sso/login/partner/p1?redirect=%2Fdevices'
    );
  });

  it('omits the SSO button when the login-context fetch degrades to null', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({ branding: null, partnerSso: null });

    render(<LoginPage />);

    await waitFor(() => screen.getByLabelText(/email/i));
    expect(screen.queryByTestId('partner-sso-button')).not.toBeInTheDocument();
  });

  it('renders the SSO link banner from ?error=sso_link_required', async () => {
    const realWindow = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realWindow, search: '?error=sso_link_required' },
    });

    render(<LoginPage />);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/This account already has a password/i);

    Object.defineProperty(window, 'location', { configurable: true, value: realWindow });
  });

  it('enforceSSO=true hides the password form initially and shows the SSO button', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: true },
    });

    render(<LoginPage />);

    await screen.findByTestId('partner-sso-button');
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('show-password-form')).toBeInTheDocument();
  });

  it('clicking "Sign in with password instead" reveals the password form', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: true },
    });

    render(<LoginPage />);

    const toggle = await screen.findByTestId('show-password-form');
    fireEvent.click(toggle);

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByTestId('show-password-form')).not.toBeInTheDocument();
  });

  it('enforceSSO=false leaves the password form visible as before', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
    });

    render(<LoginPage />);

    await screen.findByTestId('partner-sso-button');
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByTestId('show-password-form')).not.toBeInTheDocument();
  });
});

describe('LoginPage navigation after MFA verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function loginToMfaState() {
    vi.mocked(apiLogin).mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      tempToken: 'temp-1',
      mfaMethod: 'totp',
    });
    await fillAndSubmit();
    await screen.findByText(/Verify your identity/i);
  }

  async function submitMfaCode() {
    for (let i = 0; i < 6; i++) {
      const input = screen.getByTestId(`mfa-digit-${i}`) as HTMLInputElement;
      fireEvent.change(input, { target: { value: String((i + 1) % 10) } });
    }
    fireEvent.click(screen.getByTestId('mfa-submit'));
  }

  it('honors next on MFA-verify success when setup is complete', async () => {
    render(<LoginPage next="/oauth/consent?uid=abc" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce(baseLoginSuccess);
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/oauth/consent?uid=abc');
  });

  it('routes MFA verify to /setup when requiresSetup is true', async () => {
    render(<LoginPage next="/oauth/consent?uid=abc" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce({ ...baseLoginSuccess, requiresSetup: true });
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/setup');
  });

  it('rewrites unsafe next to "/" before navigating after MFA verify', async () => {
    render(<LoginPage next="https://evil.example.com" />);
    await loginToMfaState();

    vi.mocked(apiVerifyMFA).mockResolvedValueOnce(baseLoginSuccess);
    await submitMfaCode();

    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});
