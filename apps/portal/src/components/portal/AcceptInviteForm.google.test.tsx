// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { replaceLocation } from '@/lib/replaceLocation';
import AcceptInviteForm from './AcceptInviteForm';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?hd=*';
const originalFetch = globalThis.fetch;
let methods: { status: number; body: unknown };
let googleStart: { status: number; body: unknown };
let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  methods = { status: 200, body: { password: true, microsoft: false, google: true } };
  googleStart = { status: 200, body: { redirectUrl: GOOGLE_AUTHORIZE } };
  calls = [];
  window.history.replaceState({}, '', '/accept-invite?token=tok');
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).endsWith('/portal/auth/invite/methods')) {
      return { ok: methods.status < 300, status: methods.status, json: async () => methods.body };
    }
    if (String(url).endsWith('/portal/auth/oidc/google/start')) {
      return { ok: googleStart.status < 300, status: googleStart.status, json: async () => googleStart.body };
    }
    if (String(url).endsWith('/portal/auth/oidc/entra/start')) {
      return { ok: true, status: 200, json: async () => ({ redirectUrl: 'https://login.microsoftonline.com/i' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

describe('AcceptInviteForm — Google (W7)', () => {
  it('shows Continue with Google beside the password form when the invite offers Google', async () => {
    render(<AcceptInviteForm token="tok" />);
    expect((await screen.findByTestId('portal-accept-invite-google')).textContent).toBe('Continue with Google');
    expect(screen.getByLabelText(/new password/i)).toBeTruthy();
    expect(screen.getByText('or set a password')).toBeTruthy();
  });

  it('accept-invite under sso_only with only Google shows only Google', async () => {
    methods = { status: 200, body: { password: false, microsoft: false, google: true } };
    render(<AcceptInviteForm token="tok" />);
    await screen.findByTestId('portal-accept-invite-google');
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
    expect(screen.queryByTestId('portal-accept-invite-microsoft')).toBeNull();
    expect(screen.queryByText('or set a password')).toBeNull();
  });

  it('ships dark: an invite without the google key renders no Google button or copy', async () => {
    methods = { status: 200, body: { password: true, microsoft: true } };
    const { container } = render(<AcceptInviteForm token="tok" />);
    await screen.findByTestId('portal-accept-invite-microsoft');
    expect(container.innerHTML).not.toMatch(/google/i);
  });

  it('clicking Continue with Google starts the invite purpose', async () => {
    render(<AcceptInviteForm token="tok" />);
    fireEvent.click(await screen.findByTestId('portal-accept-invite-google'));
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(GOOGLE_AUTHORIZE));
    expect(calls.find((c) => c.url.endsWith('/oidc/google/start'))?.body).toEqual({ purpose: 'invite', inviteToken: 'tok' });
  });

  it('?method=google starts Google at once, exactly once', async () => {
    window.history.replaceState({}, '', '/accept-invite?token=tok&method=google');
    render(<AcceptInviteForm token="tok" />);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(GOOGLE_AUTHORIZE));
    expect(replaceLocation).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.endsWith('/oidc/entra/start'))).toBe(false);
  });

  it('?method=google does nothing when Google is not offered; ?method=microsoft never starts Google', async () => {
    window.history.replaceState({}, '', '/accept-invite?token=tok&method=google');
    methods = { status: 200, body: { password: true, microsoft: true } };
    const a = render(<AcceptInviteForm token="tok" />);
    // The Microsoft button appears only once the methods answer has landed, so
    // the auto-start effect has run by now (the password form renders before it).
    await screen.findByTestId('portal-accept-invite-microsoft');
    await new Promise((r) => setTimeout(r, 0));
    expect(replaceLocation).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith('/oidc/google/start'))).toBe(false);
    a.unmount();

    window.history.replaceState({}, '', '/accept-invite?token=tok&method=microsoft');
    methods = { status: 200, body: { password: true, microsoft: true, google: true } };
    render(<AcceptInviteForm token="tok" />);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/i'));
    expect(calls.some((c) => c.url.endsWith('/oidc/google/start'))).toBe(false);
  });

  it('a Google start answered 400 shows the invalid-invite state', async () => {
    googleStart = { status: 400, body: { error: 'Invalid or expired invite' } };
    render(<AcceptInviteForm token="tok" />);
    fireEvent.click(await screen.findByTestId('portal-accept-invite-google'));
    expect(await screen.findByText('This invite has expired')).toBeTruthy();
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('any other failed Google start shows the Google error', async () => {
    methods = { status: 200, body: { password: false, microsoft: false, google: true } };
    googleStart = { status: 503, body: {} };
    render(<AcceptInviteForm token="tok" />);
    fireEvent.click(await screen.findByTestId('portal-accept-invite-google'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Google sign-in/);
    expect(replaceLocation).not.toHaveBeenCalled();
  });
});
