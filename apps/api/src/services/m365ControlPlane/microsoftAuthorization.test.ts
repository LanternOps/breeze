import { describe, expect, it } from 'vitest';
import {
  buildMicrosoftAdminConsentUrl,
  buildMicrosoftIdentityAuthorizationUrl,
} from './microsoftAuthorization';

describe('Microsoft authorization URLs', () => {
  it('builds the fixed common-tenant admin-consent URL', () => {
    const value = new URL(buildMicrosoftAdminConsentUrl({
      clientId: '11111111-1111-1111-1111-111111111111',
      redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
      state: 'raw-state',
    }));

    expect(value.origin + value.pathname).toBe(
      'https://login.microsoftonline.com/common/adminconsent',
    );
    expect(Object.fromEntries(value.searchParams)).toEqual({
      client_id: '11111111-1111-1111-1111-111111111111',
      redirect_uri: 'https://breeze.example/api/v1/m365/consent/callback',
      state: 'raw-state',
    });
  });

  it('builds the fixed tenant identity URL with PKCE and nonce', () => {
    const value = new URL(buildMicrosoftIdentityAuthorizationUrl({
      tenantId: '22222222-2222-2222-2222-222222222222',
      clientId: '11111111-1111-1111-1111-111111111111',
      redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
      state: 'identity-state',
      nonce: 'identity-nonce',
      codeChallenge: 'pkce-challenge',
    }));

    expect(value.origin + value.pathname).toBe(
      'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/oauth2/v2.0/authorize',
    );
    expect(Object.fromEntries(value.searchParams)).toEqual({
      client_id: '11111111-1111-1111-1111-111111111111',
      response_type: 'code',
      redirect_uri: 'https://breeze.example/api/v1/m365/consent/callback',
      response_mode: 'query',
      scope: 'openid profile',
      state: 'identity-state',
      nonce: 'identity-nonce',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
    });
  });

  it('rejects noncanonical tenant IDs and off-path redirect URIs', () => {
    expect(() => buildMicrosoftIdentityAuthorizationUrl({
      tenantId: 'COMMON',
      clientId: '11111111-1111-1111-1111-111111111111',
      redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: 'challenge',
    })).toThrow('m365_authorization_invalid');
    expect(() => buildMicrosoftAdminConsentUrl({
      clientId: '11111111-1111-1111-1111-111111111111',
      redirectUri: 'https://attacker.example/callback',
      state: 'state',
    })).toThrow('m365_authorization_invalid');
  });
});
