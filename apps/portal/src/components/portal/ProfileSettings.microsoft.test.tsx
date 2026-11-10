// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { replaceLocation } from '@/lib/replaceLocation';
import { ProfileSettings } from './ProfileSettings';

const originalFetch = globalThis.fetch;
let linkStatus: { status: number; body: unknown };

beforeEach(() => {
  linkStatus = { status: 200, body: { available: true, linked: false } };
  window.history.replaceState({}, '', '/profile');
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith('/oidc/entra/link-status')) {
      return { ok: linkStatus.status < 300, status: linkStatus.status, json: async () => linkStatus.body };
    }
    if (String(url).endsWith('/oidc/entra/link/start')) {
      return { ok: true, status: 200, json: async () => ({ redirectUrl: 'https://login.microsoftonline.com/k' }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

describe('ProfileSettings — Microsoft account', () => {
  it('profile shows Connect Microsoft when available and not linked', async () => {
    render(<ProfileSettings />);
    const button = await screen.findByTestId('portal-profile-connect-microsoft');
    expect(screen.getByTestId('portal-profile-microsoft')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/k'));
  });

  it('shows Connected (no button) when linked', async () => {
    linkStatus = { status: 200, body: { available: true, linked: true } };
    render(<ProfileSettings />);
    const section = await screen.findByTestId('portal-profile-microsoft');
    expect(section.textContent).toContain('Connected');
    expect(screen.queryByTestId('portal-profile-connect-microsoft')).toBeNull();
  });

  it('is hidden when unavailable and not linked, or when the status call fails', async () => {
    linkStatus = { status: 200, body: { available: false, linked: false } };
    const a = render(<ProfileSettings />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('portal-profile-microsoft')).toBeNull();
    a.unmount();

    linkStatus = { status: 401, body: {} };
    render(<ProfileSettings />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('portal-profile-microsoft')).toBeNull();
  });

  it('renders the ?sso= banner for linked and unavailable only', async () => {
    window.history.replaceState({}, '', '/profile?sso=linked');
    const a = render(<ProfileSettings />);
    expect((await screen.findByTestId('portal-profile-sso-banner')).textContent).toContain(
      'Your Microsoft account is connected.'
    );
    a.unmount();

    window.history.replaceState({}, '', '/profile?sso=unavailable');
    const b = render(<ProfileSettings />);
    expect((await screen.findByTestId('portal-profile-sso-banner')).textContent).toContain(
      "Microsoft sign-in isn't set up for this account here."
    );
    b.unmount();

    window.history.replaceState({}, '', '/profile?sso=other');
    render(<ProfileSettings />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('portal-profile-sso-banner')).toBeNull();
  });
});
