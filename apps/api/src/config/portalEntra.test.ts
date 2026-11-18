import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPortalEntraConfig } from './portalEntra';

const CLIENT_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const VARS = [
  'PORTAL_ENTRA_CLIENT_ID',
  'PORTAL_ENTRA_CLIENT_SECRET',
  'PORTAL_ENTRA_CALLBACK_BASE_URL',
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

describe('getPortalEntraConfig', () => {
  it('returns null when either env var is empty; builds both fixed URIs from PORTAL_ENTRA_CALLBACK_BASE_URL else PUBLIC_URL', () => {
    configure({ PUBLIC_URL: 'https://breeze.example/some/path' });

    expect(getPortalEntraConfig()).toBeNull();
    configure({ PORTAL_ENTRA_CLIENT_ID: CLIENT_ID, PORTAL_ENTRA_CLIENT_SECRET: '' });
    expect(getPortalEntraConfig()).toBeNull();
    configure({ PORTAL_ENTRA_CLIENT_ID: '   ', PORTAL_ENTRA_CLIENT_SECRET: 'shh' });
    expect(getPortalEntraConfig()).toBeNull();

    // Env is read at call time: setting both turns it on without a reload.
    configure({ PORTAL_ENTRA_CLIENT_ID: CLIENT_ID, PORTAL_ENTRA_CLIENT_SECRET: 'shh' });
    expect(getPortalEntraConfig()).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      callbackUrl: 'https://breeze.example/api/v1/portal/auth/oidc/entra/callback',
      consentReturnUrl: 'https://breeze.example/api/v1/portal/auth/oidc/entra/consent-return',
    });

    configure({ PORTAL_ENTRA_CALLBACK_BASE_URL: 'https://portal.example:8443/' });
    expect(getPortalEntraConfig()).toMatchObject({
      callbackUrl: 'https://portal.example:8443/api/v1/portal/auth/oidc/entra/callback',
      consentReturnUrl: 'https://portal.example:8443/api/v1/portal/auth/oidc/entra/consent-return',
    });
  });

  it('falls back PUBLIC_URL → PUBLIC_APP_URL → PUBLIC_API_URL, treating blank as unset', () => {
    configure({
      PORTAL_ENTRA_CLIENT_ID: CLIENT_ID,
      PORTAL_ENTRA_CLIENT_SECRET: 'shh',
      PORTAL_ENTRA_CALLBACK_BASE_URL: ' ',
      PUBLIC_URL: '',
      PUBLIC_APP_URL: 'https://app.example',
      PUBLIC_API_URL: 'https://api.example',
    });
    expect(getPortalEntraConfig()?.callbackUrl).toBe('https://app.example/api/v1/portal/auth/oidc/entra/callback');

    delete process.env.PUBLIC_APP_URL;
    expect(getPortalEntraConfig()?.callbackUrl).toBe('https://api.example/api/v1/portal/auth/oidc/entra/callback');
  });

  it('normalizes the client id to the lower-case GUID Entra puts in aud', () => {
    configure({ PORTAL_ENTRA_CLIENT_ID: ` ${CLIENT_ID.toUpperCase()} `, PORTAL_ENTRA_CLIENT_SECRET: 'shh', PUBLIC_URL: 'https://breeze.example' });
    expect(getPortalEntraConfig()?.clientId).toBe(CLIENT_ID);
  });

  it.each([
    ['not a URL', 'breeze.example'],
    ['a non-HTTP scheme', 'ftp://breeze.example'],
    ['credentials', 'https://user:pw@breeze.example'],
    ['a path', 'https://breeze.example/portal'],
    ['a query', 'https://breeze.example/?a=1'],
  ])('throws on a callback base URL with %s', (_label, base) => {
    configure({ PORTAL_ENTRA_CLIENT_ID: CLIENT_ID, PORTAL_ENTRA_CLIENT_SECRET: 'shh', PORTAL_ENTRA_CALLBACK_BASE_URL: base });
    expect(() => getPortalEntraConfig()).toThrow(/PORTAL_ENTRA_CALLBACK_BASE_URL/);
  });

  it('throws on a malformed PUBLIC_URL fallback and on a client id that is not a GUID', () => {
    configure({ PORTAL_ENTRA_CLIENT_ID: CLIENT_ID, PORTAL_ENTRA_CLIENT_SECRET: 'shh', PUBLIC_URL: 'not a url' });
    expect(() => getPortalEntraConfig()).toThrow(/callback base/);

    configure({ PUBLIC_URL: 'https://breeze.example', PORTAL_ENTRA_CLIENT_ID: 'my-app' });
    expect(() => getPortalEntraConfig()).toThrow(/PORTAL_ENTRA_CLIENT_ID/);
  });

  it('requires a base in production; outside production falls back to the local API origin', () => {
    configure({ PORTAL_ENTRA_CLIENT_ID: CLIENT_ID, PORTAL_ENTRA_CLIENT_SECRET: 'shh' });
    expect(getPortalEntraConfig()?.callbackUrl).toBe('http://localhost:3001/api/v1/portal/auth/oidc/entra/callback');

    process.env.NODE_ENV = 'production';
    expect(() => getPortalEntraConfig()).toThrow(/PORTAL_ENTRA_CALLBACK_BASE_URL/);
  });

  it('reads an explicit env object when one is passed (boot validation)', () => {
    expect(getPortalEntraConfig({
      PORTAL_ENTRA_CLIENT_ID: CLIENT_ID,
      PORTAL_ENTRA_CLIENT_SECRET: 'shh',
      PUBLIC_URL: 'https://boot.example',
    })?.consentReturnUrl).toBe('https://boot.example/api/v1/portal/auth/oidc/entra/consent-return');
  });
});
