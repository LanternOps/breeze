// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { navigateTo } from '@/lib/navigation';
import { replaceLocation } from '@/lib/replaceLocation';
import { LoginForm } from './LoginForm';

const originalFetch = globalThis.fetch;
let methodsBody: unknown;
let googleStart: { status: number; body: unknown };

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?hd=*';

beforeEach(() => {
  methodsBody = { password: true, microsoft: false, google: true };
  googleStart = { status: 200, body: { redirectUrl: GOOGLE_AUTHORIZE } };
  sessionStorage.clear();
  window.history.replaceState({}, '', '/login');
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/portal/auth/methods')) {
      return { ok: true, status: 200, json: async () => methodsBody };
    }
    if (String(url).endsWith('/portal/auth/oidc/google/start')) {
      return { ok: googleStart.status < 300, status: googleStart.status, json: async () => googleStart.body };
    }
    if (String(url).endsWith('/portal/auth/oidc/entra/start')) {
      return { ok: true, status: 200, json: async () => ({ redirectUrl: 'https://login.microsoftonline.com/a' }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

async function settled() {
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  await screen.findByTestId('portal-login-submit');
}

describe('LoginForm — Google (W7)', () => {
  it('login shows Google only when methods.google', async () => {
    const a = render(<LoginForm />);
    expect((await screen.findByTestId('portal-login-google')).textContent).toBe('Sign in with Google');
    a.unmount();

    for (const body of [
      { password: true, microsoft: true },
      { password: true, microsoft: true, google: false },
      { password: true, microsoft: false, google: 'true' },
    ]) {
      methodsBody = body;
      const view = render(<LoginForm />);
      await settled();
      expect(screen.queryByTestId('portal-login-google')).toBeNull();
      view.unmount();
    }
  });

  it('ships dark: with no google key the page carries no Google button or copy at all', async () => {
    methodsBody = { password: true, microsoft: true, requestAccess: true };
    const { container } = render(<LoginForm />);
    await screen.findByTestId('portal-login-microsoft');
    expect(container.textContent).not.toMatch(/google/i);
    expect(container.innerHTML).not.toMatch(/google/i);
  });

  it('shows Microsoft and Google together under one divider', async () => {
    methodsBody = { password: true, microsoft: true, google: true };
    render(<LoginForm />);
    expect(await screen.findByTestId('portal-login-google')).toBeTruthy();
    expect(screen.getByTestId('portal-login-microsoft')).toBeTruthy();
    expect(screen.getAllByText('or')).toHaveLength(1);
  });

  it('sso_only with only Google: no password form, only the Google button', async () => {
    methodsBody = { password: false, microsoft: false, google: true };
    render(<LoginForm />);
    await screen.findByTestId('portal-login-google');
    expect(screen.queryByTestId('portal-login-submit')).toBeNull();
    expect(screen.queryByTestId('portal-login-microsoft')).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
  });

  it('clicking Google starts the login purpose with a validated next and navigates to the authorize URL', async () => {
    window.history.replaceState({}, '', '/login?next=%2Fquotes%2F7');
    render(<LoginForm />);
    fireEvent.click(await screen.findByTestId('portal-login-google'));
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(GOOGLE_AUTHORIZE));
    const call = vi.mocked(globalThis.fetch).mock.calls.find(([u]) => String(u).endsWith('/oidc/google/start'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ purpose: 'login' });
    expect(sessionStorage.getItem('portal-oidc-next')).toBe('/quotes/7');
  });

  it('a failed Google start shows the Google error and does not navigate', async () => {
    googleStart = { status: 503, body: {} };
    render(<LoginForm />);
    fireEvent.click(await screen.findByTestId('portal-login-google'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Google sign-in/);
    expect(replaceLocation).not.toHaveBeenCalled();
    expect((screen.getByTestId('portal-login-google') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sso banner with p=google renders the Google copy; without p, the Microsoft copy', async () => {
    const cases: Array<[string, string]> = [
      ['/login?sso=unavailable&p=google', "Google sign-in isn't set up for this account here."],
      ['/login?sso=bogus&p=google', "Google sign-in isn't set up for this account here."],
      [
        '/login?sso=account_exists&p=google',
        'You already have an account. Sign in with your password and connect Google, or ask your IT provider to re-invite you.',
      ],
      ['/login?sso=request_sent&p=google', "Your request was sent. You'll get an email when you can sign in."],
      ['/login?sso=unavailable', "Microsoft sign-in isn't set up for this account here."],
      [
        '/login?sso=account_exists',
        'You already have an account. Sign in with your password and connect Microsoft, or ask your IT provider to re-invite you.',
      ],
      // Any other p value is not Google.
      ['/login?sso=unavailable&p=GOOGLE', "Microsoft sign-in isn't set up for this account here."],
    ];
    for (const [url, copy] of cases) {
      window.history.replaceState({}, '', url);
      const view = render(<LoginForm />);
      expect((await screen.findByTestId('portal-login-sso-banner')).textContent, url).toBe(copy);
      view.unmount();
    }
  });

  it('request_pending (an earlier request at this address is still queued) has its own copy for both providers', async () => {
    for (const url of ['/login?sso=request_pending', '/login?sso=request_pending&p=google']) {
      window.history.replaceState({}, '', url);
      const view = render(<LoginForm />);
      const banner = await screen.findByTestId('portal-login-sso-banner');
      expect(banner.textContent, url).toBe(
        'An access request for your email address is already waiting for your IT provider. Ask them to review it, then sign in again.'
      );
      view.unmount();
    }
  });

  it('an inherited property name as the sso code gets the generic copy, not a crash', async () => {
    for (const url of ['/login?sso=__proto__', '/login?sso=constructor&p=google', '/login?sso=toString']) {
      window.history.replaceState({}, '', url);
      const view = render(<LoginForm />);
      const banner = await screen.findByTestId('portal-login-sso-banner');
      expect(banner.textContent, url).toMatch(/sign-in isn't set up for this account here\.$/);
      view.unmount();
    }
  });

  it('signed_in&p=google navigates to the stored next path and clears it', async () => {
    sessionStorage.setItem('portal-oidc-next', '/invoices/9');
    window.history.replaceState({}, '', '/login?sso=signed_in&p=google');
    render(<LoginForm />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/invoices/9', { replace: true }));
    expect(sessionStorage.getItem('portal-oidc-next')).toBeNull();
    expect(screen.queryByTestId('portal-login-sso-banner')).toBeNull();
  });
});
