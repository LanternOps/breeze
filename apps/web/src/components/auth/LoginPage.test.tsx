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
  fireEvent.click(screen.getByTestId('login-submit'));
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
    expect(btn.tagName).toBe('BUTTON');
    // Password form remains visible.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('bootstraps the browser binding before partner SSO navigation', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
    });

    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/v1/config')) {
        return new Response(JSON.stringify({ cfAccessLogin: { enabled: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    const realLocation = window.location;
    const assign = vi.fn((url: string) => { calls.push(url); });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign },
    });

    try {
      render(<LoginPage next="/devices" />);

      const btn = await screen.findByTestId('partner-sso-button');
      fireEvent.click(btn);

      await waitFor(() => expect(assign).toHaveBeenCalledWith(
        '/api/v1/sso/login/partner/p1?redirect=%2Fdevices',
      ));
      expect(calls.slice(-2)).toEqual([
        '/api/v1/auth/browser-binding/bootstrap',
        '/api/v1/sso/login/partner/p1?redirect=%2Fdevices',
      ]);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it('disables the SSO button while bootstrapping and shows the login error on failure', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: false },
    });
    let resolveBootstrap!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => { resolveBootstrap = resolve; });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/config')) {
        return new Response(JSON.stringify({ cfAccessLogin: { enabled: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return bootstrap;
    });

    render(<LoginPage />);
    const btn = await screen.findByTestId('partner-sso-button');
    fireEvent.click(btn);

    expect(btn).toBeDisabled();
    resolveBootstrap(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
    expect(await screen.findByText('Authentication bootstrap failed')).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
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
    expect(notice).toHaveTextContent(/couldn.t be connected to your account automatically/i);

    Object.defineProperty(window, 'location', { configurable: true, value: realWindow });
  });

  // #2195: callback bounces that previously landed with NO guidance at all.
  it.each([
    ['invite_required', /no account here is linked/i],
    ['no_partner_access', /does not have access to this workspace/i],
    ['identity_in_use', /already linked to a different account/i],
  ])('renders guidance copy for ?error=%s', async (error, copy) => {
    const realWindow = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realWindow, search: `?error=${error}` },
    });

    render(<LoginPage />);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(copy);

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

describe('LoginPage Cloudflare Access redirect', () => {
  it('bootstraps the browser binding before automatic redirect-login navigation', async () => {
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/v1/config')) {
        return new Response(JSON.stringify({ cfAccessLogin: { enabled: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    const realLocation = window.location;
    const assign = vi.fn((url: string) => { calls.push(url); });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, search: '', assign },
    });

    try {
      render(<LoginPage next="/devices" />);

      await waitFor(() => expect(assign).toHaveBeenCalledWith(
        '/api/v1/auth/cf-access-login?next=%2Fdevices',
      ));
      expect(calls.slice(-2)).toEqual([
        '/api/v1/auth/browser-binding/bootstrap',
        '/api/v1/auth/cf-access-login?next=%2Fdevices',
      ]);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
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

// Session-expiry polish: handleSessionExpired() redirects an expired session to
// /login?next=…&reason=<code>. Without a notice the user lands on a bare sign-in
// form with no explanation of why they were kicked out.
describe('LoginPage session-expiry notice', () => {
  function withSearch(search: string, run: () => Promise<void>, origin?: string): Promise<void> {
    const realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, search, ...(origin ? { origin } : {}) },
    });
    return run().finally(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    });
  }

  it.each([
    ['session-expired', /Your session expired\. Please sign in again to continue\./i],
    ['idle', /You were signed out due to inactivity\./i],
  ])('renders the notice for ?reason=%s', async (reason, copy) =>
    withSearch(`?next=%2Fdevices&reason=${reason}`, async () => {
      render(<LoginPage />);

      const notice = await screen.findByTestId('login-session-expired-notice');
      expect(notice).toHaveTextContent(copy);
    }));

  // A self-hoster on an SSH tunnel is bounced here after EVERY successful
  // login because the API rejects https://localhost:8443 as an origin. The
  // generic expiry copy sends them hunting for a password problem, so this
  // notice has to name the origin the browser is actually using and both
  // settings that accept it.
  it('renders the origin-rejected notice with the browser origin interpolated', async () =>
    withSearch(
      '?next=%2Fdevices&reason=origin-rejected',
      async () => {
        render(<LoginPage />);

        const notice = await screen.findByTestId('login-session-expired-notice');
        expect(notice).toHaveTextContent('https://localhost:8443');
        expect(notice).toHaveTextContent(/PUBLIC_APP_URL/);
        expect(notice).toHaveTextContent(/CORS_ALLOWED_ORIGINS/);
      },
      'https://localhost:8443',
    ));

  it('renders nothing for an unrecognized reason', async () =>
    withSearch('?reason=made-up-code', async () => {
      render(<LoginPage />);

      await waitFor(() => screen.getByLabelText(/email/i));
      expect(screen.queryByTestId('login-session-expired-notice')).not.toBeInTheDocument();
    }));

  it('renders nothing when no reason param is present', async () =>
    withSearch('', async () => {
      render(<LoginPage />);

      await waitFor(() => screen.getByLabelText(/email/i));
      expect(screen.queryByTestId('login-session-expired-notice')).not.toBeInTheDocument();
    }));

  // An SSO bounce carries the more actionable copy, so the two must not stack.
  it('lets an SSO ?error= win when both params are present', async () =>
    withSearch('?error=sso_link_required&reason=session-expired', async () => {
      render(<LoginPage />);

      const notice = await screen.findByRole('alert');
      expect(notice).toHaveTextContent(/couldn.t be connected to your account automatically/i);
      expect(screen.queryByTestId('login-session-expired-notice')).not.toBeInTheDocument();
    }));
});
