import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../stores/auth';
import { getJwtClaims, loginPathWithNext, useJwtClaims } from './authScope';

function makeToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.sig`;
}

function makeTokenBase64Url(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.sig`;
}

beforeEach(() => {
  useAuthStore.setState({ tokens: null });
});

afterEach(() => {
  useAuthStore.setState({ tokens: null });
});

describe('getJwtClaims', () => {
  it('returns all-null when no token', () => {
    const claims = getJwtClaims();
    expect(claims).toEqual({ scope: null, orgId: null, partnerId: null });
  });

  it('decodes org scope claims correctly', () => {
    const tok = makeToken({ scope: 'organization', orgId: 'org-1', partnerId: 'p-2' });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    expect(getJwtClaims()).toEqual({ scope: 'organization', orgId: 'org-1', partnerId: 'p-2' });
  });

  it('decodes partner scope claims', () => {
    const tok = makeToken({ scope: 'partner', orgId: null, partnerId: 'p-1' });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    const c = getJwtClaims();
    expect(c.scope).toBe('partner');
    expect(c.partnerId).toBe('p-1');
  });

  it('decodes system scope claims', () => {
    const tok = makeToken({ scope: 'system' });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    expect(getJwtClaims().scope).toBe('system');
  });

  it('returns null scope for unknown scope values', () => {
    const tok = makeToken({ scope: 'admin' });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    expect(getJwtClaims().scope).toBeNull();
  });

  it('returns all-null for a malformed token (no dots)', () => {
    useAuthStore.setState({ tokens: { accessToken: 'notavalidjwt', expiresInSeconds: 900 } });
    expect(getJwtClaims()).toEqual({ scope: null, orgId: null, partnerId: null });
  });

  it('returns all-null when payload is invalid JSON', () => {
    useAuthStore.setState({ tokens: { accessToken: 'x.bm90anNvbg.y', expiresInSeconds: 900 } });
    expect(getJwtClaims()).toEqual({ scope: null, orgId: null, partnerId: null });
  });

  it('handles base64url characters (- and _) in the payload', () => {
    const tok = makeTokenBase64Url({ scope: 'organization', orgId: 'org-1' });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    const c = getJwtClaims();
    expect(c.scope).toBe('organization');
    expect(c.orgId).toBe('org-1');
  });

  it('returns null for orgId/partnerId when they are not strings', () => {
    const tok = makeToken({ scope: 'organization', orgId: 123, partnerId: true });
    useAuthStore.setState({ tokens: { accessToken: tok, expiresInSeconds: 900 } });
    const c = getJwtClaims();
    expect(c.orgId).toBeNull();
    expect(c.partnerId).toBeNull();
  });
});

describe('useJwtClaims', () => {
  // #4010: the point of the hook over getJwtClaims() is that it distinguishes
  // "no token yet" (unknown) from "token says not permitted" (denied), and
  // re-renders when the token lands. Callers that destroy state on a denial —
  // clearing a deep-link hash, redirecting — hang off exactly that difference,
  // which is why the shape is a union that hides `claims` until it is narrowed.
  it('is unresolved when no token is present', () => {
    const { result } = renderHook(() => useJwtClaims());
    expect(result.current).toEqual({ status: 'unresolved' });
  });

  it('is resolved with decoded claims once a token is present', () => {
    useAuthStore.setState({
      tokens: { accessToken: makeToken({ scope: 'partner', partnerId: 'p-1' }), expiresInSeconds: 900 },
    });
    const { result } = renderHook(() => useJwtClaims());
    expect(result.current).toEqual({
      status: 'resolved',
      claims: { scope: 'partner', orgId: null, partnerId: 'p-1' },
    });
  });

  it('re-renders with the new claims when the token arrives after first render', () => {
    const { result } = renderHook(() => useJwtClaims());
    expect(result.current.status).toBe('unresolved');

    act(() => {
      useAuthStore.setState({
        tokens: { accessToken: makeToken({ scope: 'organization', orgId: 'org-1' }), expiresInSeconds: 900 },
      });
    });

    expect(result.current).toEqual({
      status: 'resolved',
      claims: { scope: 'organization', orgId: 'org-1', partnerId: null },
    });
  });

  it('counts an undecodable token as resolved (we looked; the answer is no claims)', () => {
    useAuthStore.setState({ tokens: { accessToken: 'notavalidjwt', expiresInSeconds: 900 } });
    const { result } = renderHook(() => useJwtClaims());
    expect(result.current).toEqual({
      status: 'resolved',
      claims: { scope: null, orgId: null, partnerId: null },
    });
  });

  it('goes back to unresolved when the token is cleared (logout, or a throttled refresh)', () => {
    useAuthStore.setState({
      tokens: { accessToken: makeToken({ scope: 'system' }), expiresInSeconds: 900 },
    });
    const { result } = renderHook(() => useJwtClaims());
    expect(result.current.status).toBe('resolved');

    act(() => {
      useAuthStore.setState({ tokens: null });
    });

    expect(result.current).toEqual({ status: 'unresolved' });
  });

  it('keeps the same object identity across re-renders while the token is unchanged', () => {
    // Consumers derive effect dependencies from this value; a fresh object every
    // render would re-run them on every unrelated store write. The RESOLVED
    // branch is the one that matters — it builds a new object literal inside the
    // memo callback, so it is where a future edit could silently drop the
    // caching. (The unresolved branch returns a shared constant and would look
    // stable even without the memo, so asserting only that proves nothing.)
    useAuthStore.setState({
      tokens: { accessToken: makeToken({ scope: 'partner', partnerId: 'p-1' }), expiresInSeconds: 900 },
    });
    const { result, rerender } = renderHook(() => useJwtClaims());
    const first = result.current;
    expect(first.status).toBe('resolved');

    rerender();
    expect(result.current).toBe(first);

    // A genuinely new token must produce a new value, or the memo is over-caching.
    act(() => {
      useAuthStore.setState({
        tokens: { accessToken: makeToken({ scope: 'system' }), expiresInSeconds: 900 },
      });
    });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({
      status: 'resolved',
      claims: { scope: 'system', orgId: null, partnerId: null },
    });
  });
});

describe('loginPathWithNext', () => {
  const originalLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('returns /login when at root', () => {
    // jsdom sets pathname to '/' by default
    expect(loginPathWithNext()).toBe('/login');
  });

  it('encodes the current path into next param', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/tickets', search: '', hash: '' } as Location,
    });
    expect(loginPathWithNext()).toBe('/login?next=%2Ftickets');
  });

  it('includes search and hash in the next param', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/tickets', search: '?q=open', hash: '#T-1' } as Location,
    });
    expect(loginPathWithNext()).toBe('/login?next=%2Ftickets%3Fq%3Dopen%23T-1');
  });
});
