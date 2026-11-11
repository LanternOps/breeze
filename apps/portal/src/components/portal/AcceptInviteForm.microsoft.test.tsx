// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { replaceLocation } from '@/lib/replaceLocation';
import AcceptInviteForm from './AcceptInviteForm';

const originalFetch = globalThis.fetch;
let methods: { status: number; body: unknown } | 'throw';
let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  methods = { status: 200, body: { password: true, microsoft: true } };
  calls = [];
  window.history.replaceState({}, '', '/accept-invite?token=tok');
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).endsWith('/portal/auth/invite/methods')) {
      if (methods === 'throw') throw new Error('offline');
      return { ok: methods.status < 300, status: methods.status, json: async () => (methods as { body: unknown }).body };
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

describe('AcceptInviteForm — Microsoft', () => {
  it('posts the token to /auth/invite/methods and shows both options', async () => {
    render(<AcceptInviteForm token="tok" />);
    expect(await screen.findByTestId('portal-accept-invite-microsoft')).toBeTruthy();
    expect(screen.getByLabelText(/new password/i)).toBeTruthy();
    expect(calls[0]).toEqual({ url: '/api/v1/portal/auth/invite/methods', body: { token: 'tok' } });
  });

  it('accept-invite under sso_only shows only Microsoft', async () => {
    methods = { status: 200, body: { password: false, microsoft: true } };
    render(<AcceptInviteForm token="tok" />);
    await screen.findByTestId('portal-accept-invite-microsoft');
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });

  it('hides Microsoft when the invite does not offer it', async () => {
    methods = { status: 200, body: { password: true, microsoft: false } };
    render(<AcceptInviteForm token="tok" />);
    await screen.findByLabelText(/new password/i);
    expect(screen.queryByTestId('portal-accept-invite-microsoft')).toBeNull();
  });

  it('clicking Continue with Microsoft starts the invite purpose', async () => {
    render(<AcceptInviteForm token="tok" />);
    fireEvent.click(await screen.findByTestId('portal-accept-invite-microsoft'));
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/i'));
    expect(calls.find((c) => c.url.endsWith('/oidc/entra/start'))?.body).toEqual({
      purpose: 'invite',
      inviteToken: 'tok'
    });
  });

  it('accept-invite ?method=microsoft starts immediately', async () => {
    window.history.replaceState({}, '', '/accept-invite?token=tok&method=microsoft');
    render(<AcceptInviteForm token="tok" />);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/i'));
    expect(replaceLocation).toHaveBeenCalledTimes(1);
  });

  it('?method=microsoft does nothing when Microsoft is not offered', async () => {
    window.history.replaceState({}, '', '/accept-invite?token=tok&method=microsoft');
    methods = { status: 200, body: { password: true, microsoft: false } };
    render(<AcceptInviteForm token="tok" />);
    await screen.findByLabelText(/new password/i);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('a 400 shows the invalid-invite state', async () => {
    methods = { status: 400, body: { error: 'Invalid or expired invite' } };
    render(<AcceptInviteForm token="tok" />);
    expect(await screen.findByText('This invite has expired')).toBeTruthy();
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });

  it('falls back to the password form when the methods call fails otherwise', async () => {
    methods = 'throw';
    const a = render(<AcceptInviteForm token="tok" />);
    expect(await screen.findByLabelText(/new password/i)).toBeTruthy();
    expect(screen.queryByTestId('portal-accept-invite-microsoft')).toBeNull();
    a.unmount();

    methods = { status: 503, body: {} };
    render(<AcceptInviteForm token="tok" />);
    expect(await screen.findByLabelText(/new password/i)).toBeTruthy();
  });

  it('shows an error when starting Microsoft fails', async () => {
    render(<AcceptInviteForm token="tok" />);
    const button = await screen.findByTestId('portal-accept-invite-microsoft');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({})
    });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Microsoft/);
    expect(replaceLocation).not.toHaveBeenCalled();
  });
});
