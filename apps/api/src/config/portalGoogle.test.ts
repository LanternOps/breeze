import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPortalGoogleConfig, PORTAL_GOOGLE_CALLBACK_PATH } from './portalGoogle';

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const VARS = [
  'PORTAL_GOOGLE_CLIENT_ID',
  'PORTAL_GOOGLE_CLIENT_SECRET',
  'PORTAL_GOOGLE_CALLBACK_BASE_URL',
  'PUBLIC_URL',
  'PUBLIC_APP_URL',
  'PUBLIC_API_URL',
  'NODE_ENV',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function configure(values: Partial<Record<(typeof VARS)[number], string>>) {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

describe('getPortalGoogleConfig', () => {
  it('pins the one fixed callback path (plan D10)', () => {
    expect(PORTAL_GOOGLE_CALLBACK_PATH).toBe('/api/v1/portal/auth/oidc/google/callback');
  });

  it('returns null when either env var is empty', () => {
    configure({ PUBLIC_URL: 'https://breeze.example.com' });
    expect(getPortalGoogleConfig()).toBeNull();
    configure({ PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID, PORTAL_GOOGLE_CLIENT_SECRET: '' });
    expect(getPortalGoogleConfig()).toBeNull();
    configure({ PORTAL_GOOGLE_CLIENT_ID: '   ', PORTAL_GOOGLE_CLIENT_SECRET: 'shh' });
    expect(getPortalGoogleConfig()).toBeNull();

    // Read at call time: setting both turns it on without a reload.
    configure({ PORTAL_GOOGLE_CLIENT_ID: ` ${CLIENT_ID} `, PORTAL_GOOGLE_CLIENT_SECRET: 'shh' });
    expect(getPortalGoogleConfig()).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      callbackUrl: 'https://breeze.example.com/api/v1/portal/auth/oidc/google/callback',
    });
  });

  it('a blank client id with a malformed base never throws (unconfigured is off, not an error)', () => {
    configure({ PORTAL_GOOGLE_CLIENT_SECRET: 'shh', PORTAL_GOOGLE_CALLBACK_BASE_URL: 'https://breeze.example.com/path' });
    expect(getPortalGoogleConfig()).toBeNull();
  });

  it('throws when the client id does not end in .apps.googleusercontent.com', () => {
    configure({ PUBLIC_URL: 'https://breeze.example.com', PORTAL_GOOGLE_CLIENT_SECRET: 'shh' });
    for (const bad of [
      '0f1e2d3c-4b5a-4968-8776-655443322110',
      'my-app',
      '123.apps.googleusercontent.com.example.com',
      '.apps.googleusercontent.com',
      '123 456.apps.googleusercontent.com',
    ]) {
      configure({ PORTAL_GOOGLE_CLIENT_ID: bad });
      expect(() => getPortalGoogleConfig(), bad).toThrow(/PORTAL_GOOGLE_CLIENT_ID/);
    }
  });

  it('builds the callback from PORTAL_GOOGLE_CALLBACK_BASE_URL, else PUBLIC_URL, else PUBLIC_APP_URL, else PUBLIC_API_URL', () => {
    configure({
      PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID,
      PORTAL_GOOGLE_CLIENT_SECRET: 'shh',
      PORTAL_GOOGLE_CALLBACK_BASE_URL: 'https://portal.example.com:8443/',
      PUBLIC_URL: 'https://breeze.example.com/some/path',
      PUBLIC_APP_URL: 'https://app.example.com',
      PUBLIC_API_URL: 'https://api.example.com',
    });
    expect(getPortalGoogleConfig()?.callbackUrl).toBe('https://portal.example.com:8443/api/v1/portal/auth/oidc/google/callback');

    // Blank reads as unset at every step; the fallbacks contribute only their origin.
    configure({ PORTAL_GOOGLE_CALLBACK_BASE_URL: ' ' });
    expect(getPortalGoogleConfig()?.callbackUrl).toBe('https://breeze.example.com/api/v1/portal/auth/oidc/google/callback');
    configure({ PUBLIC_URL: '' });
    expect(getPortalGoogleConfig()?.callbackUrl).toBe('https://app.example.com/api/v1/portal/auth/oidc/google/callback');
    delete process.env.PUBLIC_APP_URL;
    expect(getPortalGoogleConfig()?.callbackUrl).toBe('https://api.example.com/api/v1/portal/auth/oidc/google/callback');
  });

  it.each([
    ['not a URL', 'breeze.example.com'],
    ['a non-HTTP scheme', 'ftp://breeze.example.com'],
    ['credentials', 'https://user:pw@breeze.example.com'],
    ['a path', 'https://breeze.example.com/portal'],
    ['a query', 'https://breeze.example.com/?a=1'],
    ['a fragment', 'https://breeze.example.com/#x'],
  ])('refuses a base URL with %s', (_label, base) => {
    configure({ PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID, PORTAL_GOOGLE_CLIENT_SECRET: 'shh', PORTAL_GOOGLE_CALLBACK_BASE_URL: base });
    expect(() => getPortalGoogleConfig()).toThrow(/PORTAL_GOOGLE_CALLBACK_BASE_URL/);
  });

  it('throws on a malformed PUBLIC_URL fallback', () => {
    configure({ PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID, PORTAL_GOOGLE_CLIENT_SECRET: 'shh', PUBLIC_URL: 'not a url' });
    expect(() => getPortalGoogleConfig()).toThrow(/callback base/);
  });

  it('requires a base in production; outside production falls back to the local API origin', () => {
    configure({ PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID, PORTAL_GOOGLE_CLIENT_SECRET: 'shh' });
    expect(getPortalGoogleConfig()?.callbackUrl).toBe('http://localhost:3001/api/v1/portal/auth/oidc/google/callback');

    process.env.NODE_ENV = 'production';
    expect(() => getPortalGoogleConfig()).toThrow(/PORTAL_GOOGLE_CALLBACK_BASE_URL/);
  });

  it('reads an explicit env object when one is passed (boot validation)', () => {
    expect(getPortalGoogleConfig({
      PORTAL_GOOGLE_CLIENT_ID: CLIENT_ID,
      PORTAL_GOOGLE_CLIENT_SECRET: 'shh',
      PUBLIC_URL: 'https://boot.example.com',
    })?.callbackUrl).toBe('https://boot.example.com/api/v1/portal/auth/oidc/google/callback');
  });

  it('never puts the secret in an error message', () => {
    configure({ PORTAL_GOOGLE_CLIENT_ID: 'my-app', PORTAL_GOOGLE_CLIENT_SECRET: 'super-secret-value', PUBLIC_URL: 'https://breeze.example.com' });
    expect(() => getPortalGoogleConfig()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('super-secret-value') }));
  });
});
