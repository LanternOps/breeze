// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { replaceLocation } from '@/lib/replaceLocation';
import { ProfileSettings } from './ProfileSettings';

const originalFetch = globalThis.fetch;
let googleStatus: { status: number; body: unknown };
let linkStart: { status: number; body: unknown };

beforeEach(() => {
  googleStatus = { status: 200, body: { available: true, linked: false } };
  linkStart = { status: 200, body: { redirectUrl: 'https://accounts.google.com/link' } };
  window.history.replaceState({}, '', '/profile');
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/oidc/google/link-status')) {
      return { ok: googleStatus.status < 300, status: googleStatus.status, json: async () => googleStatus.body };
    }
    if (String(url).endsWith('/oidc/google/link/start')) {
      return { ok: linkStart.status < 300, status: linkStart.status, json: async () => linkStart.body };
    }
    if (String(url).endsWith('/oidc/entra/link-status')) {
      return { ok: true, status: 200, json: async () => ({ available: false, linked: false }) };
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
  await waitFor(() =>
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([u]) => String(u).endsWith('/oidc/google/link-status'))).toBe(true)
  );
  await new Promise((r) => setTimeout(r, 0));
}

describe('ProfileSettings — Google account (W7)', () => {
  it('profile shows Connect Google when available and not linked, and starts the link', async () => {
    render(<ProfileSettings />);
    const button = await screen.findByTestId('portal-profile-connect-google');
    expect(screen.getByTestId('portal-profile-google').textContent).toContain('Google account');
    expect(button.textContent).toBe('Continue with Google');
    fireEvent.click(button);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://accounts.google.com/link'));
  });

  it('shows Linked (no button) when linked', async () => {
    googleStatus = { status: 200, body: { available: false, linked: true } };
    render(<ProfileSettings />);
    const section = await screen.findByTestId('portal-profile-google');
    expect(section.textContent).toContain('Connected. You can sign in to the portal with Google.');
    expect(screen.queryByTestId('portal-profile-connect-google')).toBeNull();
  });

  it('a failed link start shows the Google error', async () => {
    linkStart = { status: 403, body: {} };
    render(<ProfileSettings />);
    fireEvent.click(await screen.findByTestId('portal-profile-connect-google'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Google sign-in/);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('ships dark: a 404 link status (Google not configured) renders no Google section or copy', async () => {
    googleStatus = { status: 404, body: { error: 'Not found' } };
    const { container } = render(<ProfileSettings />);
    await settled();
    expect(screen.queryByTestId('portal-profile-google')).toBeNull();
    expect(container.innerHTML).not.toMatch(/google/i);
  });

  it('is hidden when unavailable and not linked', async () => {
    googleStatus = { status: 200, body: { available: false, linked: false } };
    render(<ProfileSettings />);
    await settled();
    expect(screen.queryByTestId('portal-profile-google')).toBeNull();
  });

  it('renders the ?sso=linked|unavailable&p=google banner with Google copy', async () => {
    window.history.replaceState({}, '', '/profile?sso=linked&p=google');
    const a = render(<ProfileSettings />);
    expect((await screen.findByTestId('portal-profile-sso-banner')).textContent).toBe('Your Google account is connected.');
    a.unmount();

    window.history.replaceState({}, '', '/profile?sso=unavailable&p=google');
    render(<ProfileSettings />);
    expect((await screen.findByTestId('portal-profile-sso-banner')).textContent).toBe(
      "Google sign-in isn't set up for this account here."
    );
  });
});
