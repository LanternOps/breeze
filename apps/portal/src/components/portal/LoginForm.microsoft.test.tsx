// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { navigateTo } from '@/lib/navigation';
import { replaceLocation } from '@/lib/replaceLocation';
import { LoginForm } from './LoginForm';
import { renderToString } from 'react-dom/server';

const originalFetch = globalThis.fetch;
let methodsResponse: { ok: boolean; status: number; body: unknown } | 'throw';

beforeEach(() => {
  methodsResponse = { ok: true, status: 200, body: { password: true, microsoft: true } };
  sessionStorage.clear();
  window.history.replaceState({}, '', '/login');
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/portal/auth/methods')) {
      if (methodsResponse === 'throw') throw new Error('offline');
      return { ok: methodsResponse.ok, status: methodsResponse.status, json: async () => (methodsResponse as { body: unknown }).body };
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

describe('LoginForm — hydration', () => {
  it('the first render ignores ?sso= so it matches the server HTML (no hydration mismatch)', () => {
    window.history.replaceState({}, '', '/login?sso=request_sent');
    const html = renderToString(<LoginForm />);
    expect(html).not.toContain('portal-login-sso-banner');
  });
});

describe('LoginForm — Microsoft', () => {
  it('login shows Microsoft only when methods.microsoft', async () => {
    const { unmount } = render(<LoginForm />);
    expect(await screen.findByTestId('portal-login-microsoft')).toBeTruthy();
    expect(screen.getByTestId('portal-login-submit')).toBeTruthy();
    unmount();

    methodsResponse = { ok: true, status: 200, body: { password: true, microsoft: false } };
    render(<LoginForm />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await screen.findByTestId('portal-login-submit');
    expect(screen.queryByTestId('portal-login-microsoft')).toBeNull();
  });

  it('a failed methods fetch means password only, with no error', async () => {
    methodsResponse = 'throw';
    render(<LoginForm />);
    await screen.findByTestId('portal-login-submit');
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('portal-login-microsoft')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides the password form when password is false', async () => {
    methodsResponse = { ok: true, status: 200, body: { password: false, microsoft: true } };
    render(<LoginForm />);
    await screen.findByTestId('portal-login-microsoft');
    expect(screen.queryByTestId('portal-login-submit')).toBeNull();
    expect(screen.queryByTestId('portal-login-password')).toBeNull();
  });

  it('clicking Microsoft starts sign-in with a validated next', async () => {
    window.history.replaceState({}, '', '/login?next=%2Finvoices%2F1');
    render(<LoginForm />);
    fireEvent.click(await screen.findByTestId('portal-login-microsoft'));
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/a'));
    expect(sessionStorage.getItem('portal-oidc-next')).toBe('/invoices/1');
  });

  it('sso=request_sent and account_exists render their copy; any other code renders the generic copy', async () => {
    window.history.replaceState({}, '', '/login?sso=request_sent');
    const a = render(<LoginForm />);
    expect((await screen.findByTestId('portal-login-sso-banner')).textContent).toBe(
      "Your request was sent. You'll get an email when you can sign in."
    );
    a.unmount();

    window.history.replaceState({}, '', '/login?sso=account_exists');
    const b = render(<LoginForm />);
    expect((await screen.findByTestId('portal-login-sso-banner')).textContent).toContain(
      'You already have an account. Sign in with your password and connect Microsoft, or ask your IT provider to re-invite you.'
    );
    b.unmount();

    for (const code of ['unavailable', 'bogus']) {
      window.history.replaceState({}, '', `/login?sso=${code}`);
      const c = render(<LoginForm />);
      expect((await screen.findByTestId('portal-login-sso-banner')).textContent).toContain(
        "Microsoft sign-in isn't set up for this account here."
      );
      c.unmount();
    }
  });

  it('shows no banner for signed_in or when sso is absent', async () => {
    window.history.replaceState({}, '', '/login');
    const a = render(<LoginForm />);
    await screen.findByTestId('portal-login-submit');
    expect(screen.queryByTestId('portal-login-sso-banner')).toBeNull();
    a.unmount();
  });

  it('signed_in navigates to the stored next path via safeNextPath and clears it', async () => {
    sessionStorage.setItem('portal-oidc-next', '/invoices/42');
    window.history.replaceState({}, '', '/login?sso=signed_in');
    render(<LoginForm />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/invoices/42', { replace: true }));
    expect(sessionStorage.getItem('portal-oidc-next')).toBeNull();
    expect(screen.queryByTestId('portal-login-sso-banner')).toBeNull();
  });

  it('an unsafe ?next= is never stored for the Microsoft round trip', async () => {
    for (const unsafe of ['//evil.test', 'https://evil.test/x']) {
      sessionStorage.clear();
      window.history.replaceState({}, '', `/login?next=${encodeURIComponent(unsafe)}`);
      const { unmount } = render(<LoginForm />);
      fireEvent.click(await screen.findByTestId('portal-login-microsoft'));
      await waitFor(() => expect(replaceLocation).toHaveBeenCalled());
      expect(sessionStorage.getItem('portal-oidc-next')).toBeNull();
      unmount();
      vi.mocked(replaceLocation).mockClear();
    }
  });

  it('signed_in with nothing stored goes to the default landing', async () => {
    window.history.replaceState({}, '', '/login?sso=signed_in');
    render(<LoginForm />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('signed_in with an unsafe stored next falls back to the default landing', async () => {
    sessionStorage.setItem('portal-oidc-next', 'https://evil.test');
    window.history.replaceState({}, '', '/login?sso=signed_in');
    render(<LoginForm />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/', { replace: true }));
    expect(sessionStorage.getItem('portal-oidc-next')).toBeNull();
  });
});
