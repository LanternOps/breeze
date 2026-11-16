// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn().mockResolvedValue(undefined) }));

import { navigateTo } from '@/lib/navigation';
import { VerifyAccessRequest } from './VerifyAccessRequest';

const TOKEN = 'raw-token_AbC-123';
const originalFetch = globalThis.fetch;
let reply: { status: number; body: unknown } | 'throw';
const calls: Array<{ url: string; body: unknown }> = [];

function openLink(hash = `#token=${encodeURIComponent(TOKEN)}`) {
  window.history.replaceState(null, '', `/request-access/verify${hash}`);
}

beforeEach(() => {
  calls.length = 0;
  reply = { status: 200, body: { outcome: 'request_sent' } };
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (reply === 'throw') throw new Error('offline');
    const { status, body } = reply;
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  openLink();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

async function confirm() {
  fireEvent.click(await screen.findByTestId('request-access-confirm'));
}

describe('VerifyAccessRequest', () => {
  it('the verify page does not post on load', async () => {
    // Mail scanners and link prefetchers GET the page; only the explicit
    // Confirm click may spend the single-use link (Review Focus 4).
    render(<VerifyAccessRequest />);
    expect(await screen.findByTestId('request-access-confirm')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('the server render carries no token-dependent markup (hydration matches)', () => {
    const html = renderToString(<VerifyAccessRequest />);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('request-access-invalid');
  });

  it('the verify page removes the token from the address bar', async () => {
    window.history.replaceState(null, '', `/request-access/verify?x=1#token=${TOKEN}`);
    render(<VerifyAccessRequest />);
    await screen.findByTestId('request-access-confirm');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname + window.location.search).toBe('/request-access/verify?x=1');
  });

  it('confirm posts the token once and renders request_sent', async () => {
    render(<VerifyAccessRequest />);
    await confirm();
    expect(await screen.findByTestId('request-access-request-sent')).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/portal\/auth\/self-register\/verify$/);
    expect(calls[0]!.body).toEqual({ token: TOKEN });
    // The button is gone: a second click cannot post a spent token.
    expect(screen.queryByTestId('request-access-confirm')).toBeNull();
  });

  it('renders request_unavailable and existing_account', async () => {
    reply = { status: 200, body: { outcome: 'request_unavailable' } };
    const first = render(<VerifyAccessRequest />);
    await confirm();
    expect((await screen.findByTestId('request-access-unavailable')).textContent).toMatch(/Contact your IT provider/);
    first.unmount();

    openLink();
    reply = { status: 200, body: { outcome: 'existing_account' } };
    render(<VerifyAccessRequest />);
    await confirm();
    const existing = await screen.findByTestId('request-access-existing');
    expect(existing.textContent).toMatch(/already have an account/);
    const hrefs = [...existing.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.endsWith('/login'))).toBe(true);
    expect(hrefs.some((h) => h?.endsWith('/forgot-password'))).toBe(true);
  });

  it('account_created navigates to the returned accept-invite path', async () => {
    reply = { status: 200, body: { outcome: 'account_created', next: '/accept-invite?token=invite-abc' } };
    render(<VerifyAccessRequest />);
    await confirm();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/accept-invite?token=invite-abc', { replace: true }));
    expect(screen.getByTestId('request-access-created')).toBeTruthy();
  });

  it('account_created with a next that is not the accept-invite page navigates nowhere, and offers no retry', async () => {
    // The server consumed the token on any 200, so a retry could only 400.
    for (const next of [
      'https://evil.example.com/accept-invite?token=x', '//evil.example.com/x', '/dashboard', 42,
      '/accept-invite?token=', '/accept-invite?token=x#y', '/accept-invite?token=a/b', '/portal/accept-invite?token=x',
    ]) {
      cleanup();
      openLink();
      reply = { status: 200, body: { outcome: 'account_created', next } };
      render(<VerifyAccessRequest />);
      await confirm();
      expect(await screen.findByTestId('request-access-spent'), String(next)).toBeTruthy();
      expect(screen.queryByTestId('request-access-confirm'), String(next)).toBeNull();
    }
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('an unrecognised 200 body is a spent link, not a retry', async () => {
    reply = { status: 200, body: { outcome: 'something_new' } };
    render(<VerifyAccessRequest />);
    await confirm();
    expect(await screen.findByTestId('request-access-spent')).toBeTruthy();
    expect(screen.queryByTestId('request-access-confirm')).toBeNull();
  });

  it('a 503 sent after the link was consumed shows the server copy and drops Confirm', async () => {
    for (const error of [
      "Your account was created, but we couldn't finish setting it up. Ask your IT provider to resend your invitation.",
      'Something went wrong. Request access again in a few minutes.',
    ]) {
      cleanup();
      openLink();
      reply = { status: 503, body: { error, code: 'SELF_REGISTER_LINK_SPENT' } };
      render(<VerifyAccessRequest />);
      await confirm();
      expect((await screen.findByTestId('request-access-spent')).textContent).toContain(error);
      expect(screen.queryByTestId('request-access-confirm')).toBeNull();
    }
  });

  it('a retry after a retryable failure posts the same token again and can succeed', async () => {
    reply = { status: 503, body: { error: 'Service temporarily unavailable' } };
    render(<VerifyAccessRequest />);
    await confirm();
    await screen.findByTestId('request-access-error');
    reply = { status: 200, body: { outcome: 'request_sent' } };
    fireEvent.click(screen.getByTestId('request-access-confirm'));
    expect(await screen.findByTestId('request-access-request-sent')).toBeTruthy();
    expect(calls.map((c) => c.body)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
  });

  it('a 400 says the link is invalid or expired and links back to request access', async () => {
    reply = { status: 400, body: { error: 'This link is invalid or has expired. Request access again.' } };
    render(<VerifyAccessRequest />);
    await confirm();
    const invalid = await screen.findByTestId('request-access-invalid');
    expect(invalid.textContent).toMatch(/invalid or has expired/);
    expect(invalid.querySelector('a')?.getAttribute('href')).toMatch(/\/request-access$/);
  });

  it('no token in the fragment: invalid link, no Confirm button, no request', async () => {
    openLink('');
    render(<VerifyAccessRequest />);
    expect(await screen.findByTestId('request-access-invalid')).toBeTruthy();
    expect(screen.queryByTestId('request-access-confirm')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('429, 503 and network failures show the reason and keep Confirm for a retry', async () => {
    for (const r of [
      { status: 429, body: { error: 'Too many requests. Please try again later.' } },
      { status: 503, body: { error: 'Service temporarily unavailable' } },
      'throw' as const,
    ]) {
      cleanup();
      openLink();
      reply = r;
      render(<VerifyAccessRequest />);
      await confirm();
      expect(await screen.findByTestId('request-access-error')).toBeTruthy();
      expect(screen.getByTestId('request-access-confirm')).toBeTruthy();
    }
  });

  it('a 404 says requesting access is not available here', async () => {
    reply = { status: 404, body: { error: 'Not found' } };
    render(<VerifyAccessRequest />);
    await confirm();
    expect((await screen.findByTestId('request-access-error')).textContent).toMatch(/isn't available here/);
    expect(screen.queryByTestId('request-access-confirm')).toBeNull();
  });
});
