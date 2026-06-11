import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../stores/auth';
import { getJwtClaims, loginPathWithNext } from './authScope';

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
