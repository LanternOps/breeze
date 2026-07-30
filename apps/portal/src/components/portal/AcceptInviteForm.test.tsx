// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// `astro:transitions/client` is a virtual module Vite cannot resolve under vitest,
// and it is reachable from the api/navigation import chain — mock it out, as
// NewTicketForm.test.tsx does.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { renderToString } from 'react-dom/server';

import AcceptInviteForm from './AcceptInviteForm';

// `buildPortalApiUrl` is deliberately NOT mocked: the whole point of this test is
// to pin the literal path the browser posts to. Issue #2824 — the form posted to
// `/auth/accept-invite`, which resolves to the ADMIN accept-invite route. That
// route reads a different Redis namespace (`invite:*`, not `portal:invite:*`) and
// only ever looks the id up in `users`, so a perfectly valid portal invite came
// back "Invalid or expired invite token" and every portal invite was unusable.
// Every sibling portal auth call (`login`, `logout`, `forgot-password`,
// `reset-password`) already carries the `/portal` prefix.

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true })
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  cleanup();
});

async function submitValidPassword() {
  render(<AcceptInviteForm token="invite-token-abc" />);
  fireEvent.input(screen.getByLabelText(/new password/i), { target: { value: 'Password123' } });
  fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123' } });
  fireEvent.submit(screen.getByRole('button'));
  await waitFor(() => expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled());
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
}

describe('AcceptInviteForm — posts to the portal-scoped accept-invite route (#2824)', () => {
  it('posts to /api/v1/portal/auth/accept-invite', async () => {
    const [url] = await submitValidPassword();
    expect(url).toBe('/api/v1/portal/auth/accept-invite');
  });

  it('does NOT post to the admin /api/v1/auth/accept-invite route', async () => {
    const [url] = await submitValidPassword();
    expect(url).not.toBe('/api/v1/auth/accept-invite');
  });

  it('sends the invite token in the body', async () => {
    const [, init] = await submitValidPassword();
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      token: 'invite-token-abc'
    });
  });
});

describe('AcceptInviteForm — pre-hydration fallback must never GET-submit credentials (#2868)', () => {
  // Astro SSRs the island with `client:load`; until React hydrates, the raw
  // HTML is what the browser gets. A bare <form> with no method falls back to
  // a native GET submit that serializes ?password=...&confirmPassword=... into
  // the URL (history, proxies, access logs) and drops the invite token.
  // renderToString reproduces exactly that pre-hydration HTML.

  it('SSR HTML declares method="post" on the form', () => {
    const html = renderToString(<AcceptInviteForm token="invite-token-abc" />);
    expect(html).toMatch(/<form[^>]*method="post"/i);
    // and never an explicit GET or a page action that would carry a query string
    expect(html).not.toMatch(/<form[^>]*method="get"/i);
  });

  it('SSR HTML renders the submit button disabled until hydration', () => {
    // Parse the SSR HTML instead of substring-matching the tag: the button's
    // className contains Tailwind `disabled:` variants, so a naive
    // `toContain('disabled')` passes even when the attribute is missing.
    const container = document.createElement('div');
    container.innerHTML = renderToString(<AcceptInviteForm token="invite-token-abc" />);
    const button = container.querySelector('button[type="submit"]');
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  it('enables the submit button after hydration and still submits via fetch', async () => {
    render(<AcceptInviteForm token="invite-token-abc" />);
    const button = screen.getByRole('button', {
      name: /set password & activate/i
    }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.input(screen.getByLabelText(/new password/i), { target: { value: 'Password123' } });
    fireEvent.input(screen.getByLabelText(/confirm password/i), { target: { value: 'Password123' } });
    fireEvent.click(button);
    await waitFor(() => expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/v1/portal/auth/accept-invite');
  });
});
