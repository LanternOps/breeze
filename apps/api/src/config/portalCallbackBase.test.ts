import { describe, expect, it } from 'vitest';
import { getPortalEntraConfig } from './portalEntra';
import { getPortalGoogleConfig } from './portalGoogle';
import { resolvePortalCallbackOrigin } from './portalCallbackBase';

/**
 * The callback-origin validation shared by the portal's Entra app (W4) and
 * Google client (W7). The Entra strings below are the pre-refactor messages,
 * pinned exactly so the extraction stays byte-identical for Entra.
 */

const ENTRA = { baseVar: 'PORTAL_ENTRA_CALLBACK_BASE_URL', clientIdVar: 'PORTAL_ENTRA_CLIENT_ID', label: 'Entra' };
const ENTRA_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

describe('resolvePortalCallbackOrigin', () => {
  it('keeps the Entra error strings byte-identical', () => {
    const entra = (env: Record<string, string>) => () =>
      getPortalEntraConfig({ PORTAL_ENTRA_CLIENT_ID: ENTRA_ID, PORTAL_ENTRA_CLIENT_SECRET: 'shh', ...env });
    expect(messageOf(entra({ PORTAL_ENTRA_CALLBACK_BASE_URL: 'https://breeze.example.com/portal' })))
      .toBe('PORTAL_ENTRA_CALLBACK_BASE_URL must be an origin-only HTTP(S) URL (scheme://host[:port])');
    expect(messageOf(entra({ NODE_ENV: 'production' })))
      .toBe('PORTAL_ENTRA_CALLBACK_BASE_URL, PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required when PORTAL_ENTRA_CLIENT_ID is set');
    expect(messageOf(entra({ PUBLIC_URL: 'not a url' })))
      .toBe('The portal Entra callback base (PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL) must be a valid HTTP(S) URL');
  });

  it('names the Google variables in the Google errors', () => {
    const google = (env: Record<string, string>) => () =>
      getPortalGoogleConfig({ PORTAL_GOOGLE_CLIENT_ID: GOOGLE_ID, PORTAL_GOOGLE_CLIENT_SECRET: 'shh', ...env });
    expect(messageOf(google({ PORTAL_GOOGLE_CALLBACK_BASE_URL: 'https://breeze.example.com/portal' })))
      .toBe('PORTAL_GOOGLE_CALLBACK_BASE_URL must be an origin-only HTTP(S) URL (scheme://host[:port])');
    expect(messageOf(google({ NODE_ENV: 'production' })))
      .toBe('PORTAL_GOOGLE_CALLBACK_BASE_URL, PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required when PORTAL_GOOGLE_CLIENT_ID is set');
    expect(messageOf(google({ PUBLIC_URL: 'not a url' })))
      .toBe('The portal Google callback base (PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL) must be a valid HTTP(S) URL');
  });

  it('origin only: drops a fallback path, refuses credentials, falls back to the local API outside production', () => {
    expect(resolvePortalCallbackOrigin({ PUBLIC_URL: 'https://breeze.example.com/some/path' }, ENTRA)).toBe('https://breeze.example.com');
    expect(() => resolvePortalCallbackOrigin({ PUBLIC_URL: 'https://user:pw@breeze.example.com' }, ENTRA)).toThrow(/callback base/);
    expect(resolvePortalCallbackOrigin({}, ENTRA)).toBe('http://localhost:3001');
  });
});
