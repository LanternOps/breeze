import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { login: ReturnType<typeof vi.fn> }) => unknown) => selector({ login: vi.fn() }),
    {},
  ),
  apiLogin: vi.fn(),
  apiVerifyMFA: vi.fn(),
  apiVerifyPasskeyMFA: vi.fn(),
  apiSendSmsMfaCode: vi.fn(),
  fetchAndApplyPreferences: vi.fn(),
  fetchWithAuth: vi.fn(async () => new Response('{}', { status: 200 })),
}));

vi.mock('../../lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('../../lib/loginContext', () => ({
  getLoginContext: vi.fn(async () => ({ branding: null, partnerSso: null })),
}));

vi.mock('../../lib/ssoDiscovery', () => ({
  discoverOrgSso: vi.fn(async () => null),
}));

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
import { discoverOrgSso } from '../../lib/ssoDiscovery';
import { getLoginContext } from '../../lib/loginContext';

const AUTHENTIK = {
  providerName: 'Authentik',
  loginUrl: '/api/v1/sso/login/00000000-0000-4000-8000-0000000000a1',
  enforceSSO: true as const,
};

async function enterEmail(email: string) {
  const field = await screen.findByLabelText(/email/i);
  fireEvent.change(field, { target: { value: email } });
  fireEvent.blur(field);
  return field;
}

// #3229: an org with enforce_sso=true used to render the plain password form —
// the user was never offered SSO and the server rejected every password.
describe('LoginPage org-level SSO discovery (#3229)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverOrgSso).mockResolvedValue(null);
    vi.mocked(getLoginContext).mockResolvedValue({ branding: null, partnerSso: null });
  });

  it('collapses the password field and offers the IdP once the address resolves to an SSO-mandating org', async () => {
    vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

    render(<LoginPage />);
    await enterEmail('tech@acme.example');

    expect(await screen.findByTestId('org-sso-button')).toHaveTextContent(/Authentik/);
    await waitFor(() => expect(screen.queryByTestId('login-password-input')).not.toBeInTheDocument());
    expect(screen.queryByTestId('login-submit')).not.toBeInTheDocument();
  });

  // The email field is the input discovery keys on: unmounting it would strand
  // a user who typo'd the address with no way to correct it.
  it('keeps the email field visible while the password controls are collapsed', async () => {
    vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

    render(<LoginPage />);
    await enterEmail('tech@acme.example');

    await screen.findByTestId('org-sso-button');
    expect(screen.getByLabelText(/email/i)).toHaveValue('tech@acme.example');
  });

  it('leaves the password form untouched when the address resolves to nothing', async () => {
    render(<LoginPage />);
    await enterEmail('someone@unknown.example');

    await waitFor(() => expect(discoverOrgSso).toHaveBeenCalledWith('someone@unknown.example'));
    expect(screen.getByTestId('login-password-input')).toBeInTheDocument();
    expect(screen.queryByTestId('org-sso-button')).not.toBeInTheDocument();
  });

  it('restores the password form when the user asks for it', async () => {
    vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

    render(<LoginPage />);
    await enterEmail('tech@acme.example');

    fireEvent.click(await screen.findByTestId('org-sso-use-password'));

    expect(await screen.findByTestId('login-password-input')).toBeInTheDocument();
    expect(screen.queryByTestId('org-sso-button')).not.toBeInTheDocument();
  });

  it('re-collapses when the user then types an address at a different SSO-mandating org', async () => {
    vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

    render(<LoginPage />);
    await enterEmail('tech@acme.example');
    fireEvent.click(await screen.findByTestId('org-sso-use-password'));
    expect(await screen.findByTestId('login-password-input')).toBeInTheDocument();

    vi.mocked(discoverOrgSso).mockResolvedValue({ ...AUTHENTIK, providerName: 'Keycloak' });
    await enterEmail('tech@other.example');

    expect(await screen.findByTestId('org-sso-button')).toHaveTextContent(/Keycloak/);
  });

  describe('starting the SSO flow', () => {
    it('bootstraps the browser binding, then navigates to the org entry route with the redirect', async () => {
      vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

      const calls: string[] = [];
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
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
      Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });

      try {
        render(<LoginPage next="/devices" />);
        await enterEmail('tech@acme.example');
        fireEvent.click(await screen.findByTestId('org-sso-button'));

        await waitFor(() => expect(assign).toHaveBeenCalledWith(
          `${AUTHENTIK.loginUrl}?redirect=%2Fdevices`,
        ));
        // The binding bootstrap must PRECEDE the navigation, or the SSO
        // callback lands with no browser transition to recover.
        expect(calls.slice(-2)).toEqual([
          '/api/v1/auth/browser-binding/bootstrap',
          `${AUTHENTIK.loginUrl}?redirect=%2Fdevices`,
        ]);
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
      }
    });

    // Enter in the email field must start the SSO flow, not run the password
    // validator against a field that is no longer rendered.
    it('starts the SSO flow on implicit form submission', async () => {
      vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

      const realLocation = window.location;
      const assign = vi.fn();
      Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });

      try {
        render(<LoginPage />);
        await enterEmail('tech@acme.example');
        const button = await screen.findByTestId('org-sso-button');
        fireEvent.submit(button.closest('form')!);

        // `?redirect=%2F` because getSafeNext() defaults to "/" — same URL the
        // partner-axis button builds when no `next` is present.
        await waitFor(() => expect(assign).toHaveBeenCalledWith(`${AUTHENTIK.loginUrl}?redirect=%2F`));
        expect(screen.queryByTestId('login-password-error')).not.toBeInTheDocument();
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
      }
    });

    it('disables the button while bootstrapping and surfaces a bootstrap failure', async () => {
      vi.mocked(discoverOrgSso).mockResolvedValue(AUTHENTIK);

      let resolveBootstrap!: (response: Response) => void;
      const bootstrap = new Promise<Response>((resolve) => { resolveBootstrap = resolve; });
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
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
      await enterEmail('tech@acme.example');
      const button = await screen.findByTestId('org-sso-button');
      fireEvent.click(button);

      expect(button).toBeDisabled();
      resolveBootstrap(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));

      expect(await screen.findByText('Authentication bootstrap failed')).toBeInTheDocument();
      expect(button).not.toBeDisabled();
    });
  });

  // Partner-axis enforcement collapses the whole form at page load, so there is
  // no email field to discover from. Locking this in: it is the one shape where
  // org discovery deliberately never runs, and a future change that made the
  // partner collapse keep the form would silently start firing discovery.
  it('never runs discovery when partner-axis enforcement has already collapsed the form', async () => {
    vi.mocked(getLoginContext).mockResolvedValue({
      branding: null,
      partnerSso: { providerName: 'Okta', loginUrl: '/api/v1/sso/login/partner/p1', enforceSSO: true },
    });

    render(<LoginPage />);

    await screen.findByTestId('show-password-form');
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(discoverOrgSso).not.toHaveBeenCalled();
  });

  describe('request discipline', () => {
    it('does not ask about a half-typed address', async () => {
      render(<LoginPage />);
      await enterEmail('tech@');

      expect(discoverOrgSso).not.toHaveBeenCalled();
    });

    it('asks once per address, not once per blur', async () => {
      render(<LoginPage />);
      const field = await enterEmail('tech@acme.example');
      fireEvent.blur(field);
      fireEvent.blur(field);

      expect(discoverOrgSso).toHaveBeenCalledTimes(1);
    });

    it('normalizes the address before asking', async () => {
      render(<LoginPage />);
      await enterEmail('  Tech@ACME.Example  ');

      expect(discoverOrgSso).toHaveBeenCalledWith('tech@acme.example');
    });

    // A slow answer for an address the user has already replaced must not
    // resurrect an SSO button for a tenant they are no longer signing in to.
    it('ignores a stale answer that lands after the address changed', async () => {
      let resolveFirst: (v: typeof AUTHENTIK | null) => void = () => {};
      vi.mocked(discoverOrgSso)
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce(null);

      render(<LoginPage />);
      await enterEmail('tech@acme.example');
      await enterEmail('someone@unknown.example');
      await waitFor(() => expect(discoverOrgSso).toHaveBeenCalledTimes(2));

      resolveFirst(AUTHENTIK);

      await waitFor(() => expect(screen.getByTestId('login-password-input')).toBeInTheDocument());
      expect(screen.queryByTestId('org-sso-button')).not.toBeInTheDocument();
    });
  });
});
