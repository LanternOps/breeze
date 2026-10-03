import { describe, expect, it } from 'vitest';
import {
  buildMicrosoftIdentityAuthorizationUrl,
  buildMicrosoftTenantAdminConsentUrl,
} from './microsoftAuthorization';

const CLIENT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const READ_CB = 'https://breeze.example/api/v1/m365/consent/callback';
const READ_PATH = '/api/v1/m365/consent/callback';
const ACTIONS_CB = 'https://breeze.example/api/v1/m365/actions-consent/callback';
const ACTIONS_PATH = '/api/v1/m365/actions-consent/callback';

function identity(overrides: Partial<Parameters<typeof buildMicrosoftIdentityAuthorizationUrl>[0]> = {}) {
  return buildMicrosoftIdentityAuthorizationUrl({
    authority: 'organizations',
    clientId: CLIENT,
    redirectUri: READ_CB,
    expectedCallbackPath: READ_PATH,
    state: 's',
    nonce: 'n',
    codeChallenge: 'c',
    ...overrides,
  });
}

function consent(overrides: Partial<Parameters<typeof buildMicrosoftTenantAdminConsentUrl>[0]> = {}) {
  return buildMicrosoftTenantAdminConsentUrl({
    tenantId: TENANT,
    clientId: CLIENT,
    redirectUri: READ_CB,
    expectedCallbackPath: READ_PATH,
    state: 's2',
    ...overrides,
  });
}

describe('identity authorization URL (phase 1, v2 OIDC + PKCE)', () => {
  it('builds the organizations identity URL', () => {
    const url = new URL(identity());
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      response_type: 'code',
      redirect_uri: READ_CB,
      response_mode: 'query',
      scope: 'openid profile',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  });

  it('pins the authority to a bound tenant GUID and still forces the account picker', () => {
    const url = new URL(identity({ authority: TENANT }));
    expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    // Reconnect / manifest upgrade gets the same picker as initial connect.
    expect(url.searchParams.getAll('prompt')).toEqual(['select_account']);
  });

  it('builds the actions-profile URL against the actions callback path', () => {
    const url = new URL(identity({ redirectUri: ACTIONS_CB, expectedCallbackPath: ACTIONS_PATH }));
    expect(url.searchParams.get('redirect_uri')).toBe(ACTIONS_CB);
  });

  it.each(['common', 'consumers', 'contoso.example', 'ORGANIZATIONS', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', ''])(
    'rejects identity authority %s',
    (authority) => {
      expect(() => identity({ authority })).toThrow('m365_authorization_invalid');
    },
  );
});

describe('tenant admin-consent URL (phase 2, v1 authorize)', () => {
  it('builds the v1 tenant-pinned admin-consent URL with exactly the decided parameters', () => {
    const url = new URL(consent());
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      response_type: 'code',
      redirect_uri: READ_CB,
      resource: 'https://graph.microsoft.com',
      prompt: 'admin_consent',
      state: 's2',
    });
  });

  it.each(['organizations', 'common', 'not-a-guid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])(
    'refuses to build a consent URL for non-tenant %s',
    (tenantId) => {
      expect(() => consent({ tenantId })).toThrow('m365_authorization_invalid');
    },
  );

  it('rejects a redirect URI whose path is not the profile callback', () => {
    expect(() => consent({ expectedCallbackPath: ACTIONS_PATH })).toThrow('m365_authorization_invalid');
    expect(() => consent({ redirectUri: 'https://attacker.example/callback' })).toThrow('m365_authorization_invalid');
    expect(() => consent({ redirectUri: `${READ_CB}?x=1` })).toThrow('m365_authorization_invalid');
  });

  it('rejects a non-GUID client id and an unbounded state', () => {
    expect(() => consent({ clientId: 'app' })).toThrow('m365_authorization_invalid');
    expect(() => consent({ state: 'x'.repeat(257) })).toThrow('m365_authorization_invalid');
    expect(() => consent({ state: '' })).toThrow('m365_authorization_invalid');
  });
});

it('no longer exports the /common/adminconsent builder', async () => {
  expect('buildMicrosoftAdminConsentUrl' in (await import('./microsoftAuthorization'))).toBe(false);
});
