// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { replaceLocation } from './replaceLocation';
import {
  OIDC_NEXT_KEY,
  getInviteMethods,
  getLinkStatus,
  getSignInMethods,
  startMicrosoftLink,
  startMicrosoftSignIn,
  takeStoredNext
} from './oidc';

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  sessionStorage.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchMock.mockReset();
  vi.clearAllMocks();
});

describe('getSignInMethods', () => {
  it('GETs the public methods endpoint', async () => {
    reply(200, { password: true, microsoft: true });
    expect(await getSignInMethods()).toEqual({ password: true, microsoft: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/portal/auth/methods');
  });

  it('returns null on failure (caller falls back to password only)', async () => {
    reply(503, {});
    expect(await getSignInMethods()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await getSignInMethods()).toBeNull();
  });
});

describe('startMicrosoftSignIn', () => {
  it('posts the login purpose, stores next, and navigates to redirectUrl', async () => {
    reply(200, { redirectUrl: 'https://login.microsoftonline.com/x' });
    const result = await startMicrosoftSignIn({ purpose: 'login', next: '/invoices/1' });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/portal/auth/oidc/entra/start');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ purpose: 'login' });
    expect(sessionStorage.getItem(OIDC_NEXT_KEY)).toBe('/invoices/1');
    expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/x');
  });

  it('a start without next clears a destination left by an abandoned attempt', async () => {
    sessionStorage.setItem(OIDC_NEXT_KEY, '/stale');
    reply(200, { redirectUrl: 'https://login.microsoftonline.com/z' });
    await startMicrosoftSignIn({ purpose: 'login' });
    expect(sessionStorage.getItem(OIDC_NEXT_KEY)).toBeNull();
  });

  it('sends the invite token for the invite purpose', async () => {
    reply(200, { redirectUrl: 'https://login.microsoftonline.com/y' });
    await startMicrosoftSignIn({ purpose: 'invite', inviteToken: 'tok' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ purpose: 'invite', inviteToken: 'tok' });
    expect(sessionStorage.getItem(OIDC_NEXT_KEY)).toBeNull();
  });

  it.each([400, 404, 429, 503])('returns one generic error for HTTP %i and does not navigate', async (status) => {
    reply(status, { error: 'Invalid or expired invite' });
    const result = await startMicrosoftSignIn({ purpose: 'login' });
    expect(result.ok).toBe(false);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('fails when the response has no redirectUrl or the network is down', async () => {
    reply(200, {});
    expect((await startMicrosoftSignIn({ purpose: 'login' })).ok).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect((await startMicrosoftSignIn({ purpose: 'login' })).ok).toBe(false);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('survives sessionStorage throwing', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    reply(200, { redirectUrl: 'https://login.microsoftonline.com/z' });
    const result = await startMicrosoftSignIn({ purpose: 'login', next: '/quotes' });
    spy.mockRestore();
    expect(result.ok).toBe(true);
    expect(replaceLocation).toHaveBeenCalled();
  });
});

describe('startMicrosoftLink', () => {
  it('posts with the CSRF header and navigates', async () => {
    document.cookie = 'breeze_portal_csrf_token=csrf123';
    reply(200, { redirectUrl: 'https://login.microsoftonline.com/l' });
    expect(await startMicrosoftLink()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/portal/auth/oidc/entra/link/start');
    expect(new Headers(init.headers).get('x-breeze-csrf')).toBe('csrf123');
    expect(init.credentials).toBe('include');
    expect(replaceLocation).toHaveBeenCalledWith('https://login.microsoftonline.com/l');
  });

  it('returns an error on 403', async () => {
    reply(403, {});
    expect((await startMicrosoftLink()).ok).toBe(false);
  });
});

describe('getInviteMethods', () => {
  it('posts the token and returns methods', async () => {
    reply(200, { password: false, microsoft: true });
    expect(await getInviteMethods('t')).toEqual({ status: 'ok', methods: { password: false, microsoft: true } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/portal/auth/invite/methods');
    expect(JSON.parse(init.body)).toEqual({ token: 't' });
  });

  it('distinguishes an invalid invite (400) from a transient failure', async () => {
    reply(400, { error: 'Invalid or expired invite' });
    expect(await getInviteMethods('t')).toEqual({ status: 'invalid' });
    reply(503, {});
    expect(await getInviteMethods('t')).toEqual({ status: 'unavailable' });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await getInviteMethods('t')).toEqual({ status: 'unavailable' });
  });
});

describe('getLinkStatus', () => {
  it('returns the status or null', async () => {
    reply(200, { available: true, linked: false });
    expect(await getLinkStatus()).toEqual({ available: true, linked: false });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/portal/auth/oidc/entra/link-status');
    reply(401, {});
    expect(await getLinkStatus()).toBeNull();
  });
});

describe('takeStoredNext', () => {
  it('reads and clears', () => {
    sessionStorage.setItem(OIDC_NEXT_KEY, '/quotes');
    expect(takeStoredNext()).toBe('/quotes');
    expect(takeStoredNext()).toBeNull();
  });
});
