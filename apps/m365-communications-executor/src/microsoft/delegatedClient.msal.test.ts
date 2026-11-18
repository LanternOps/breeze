import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfidentialClientApplication, type INetworkModule, type NetworkResponse } from '@azure/msal-node';
import { describe, expect, it, vi } from 'vitest';
import { DelegatedTokenCache } from '../credentials/delegatedTokenCache';
import { InMemoryTokenCacheStore } from '../credentials/inMemoryTokenCacheStore';
import type { KekKeyring } from '../credentials/tokenCacheCrypto';
import {
  DELEGATED_REDEMPTION_SCOPES,
  createDelegatedCredentialBroker,
  msalConfidentialClientConfiguration,
  type ConfidentialClientPort,
} from './delegatedClient';

/**
 * Contract tests against the REAL @azure/msal-node (#9978). The sibling
 * delegatedClient.test.ts drives the broker through a hand-written stub CCA,
 * so a breaking change inside MSAL (cache schema, nonce validation, error
 * classes) can never turn it red. Here only the network is faked — a
 * scripted Entra that answers discovery and the token endpoint — and every
 * other line is the installed MSAL.
 */

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CONNECTION_A = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_OID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const HOLDER = '66666666-6666-4666-8666-666666666666';
const KEK_V1 = 'a'.repeat(32);
const NONCE = 'consent-session-nonce';
const REDIRECT_URI = 'https://breeze.example.test/api/v1/m365/consent/callback';

const FIXTURES = path.resolve(__dirname, '../test/fixtures');
const CERTIFICATE_PEM = readFileSync(path.join(FIXTURES, 'client-cert.pem'), 'utf8');
const PRIVATE_KEY_PEM = readFileSync(path.join(FIXTURES, 'client-key.pem'), 'utf8');

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })),
    b64url(JSON.stringify({
      aud: CLIENT_ID,
      iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      tid: TENANT_ID,
      oid: USER_OID,
      sub: 'subject',
      preferred_username: 'user@contoso.example',
      name: 'Fixture User',
      ver: '2.0',
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    })),
    'signature',
  ].join('.');
}

interface TokenReply {
  status: number;
  body: Record<string, unknown>;
}

function tokenSuccess(options: {
  accessToken: string;
  refreshToken: string;
  nonce?: string;
  expiresIn?: number;
}): TokenReply {
  const expiresIn = options.expiresIn ?? 3600;
  return {
    status: 200,
    body: {
      token_type: 'Bearer',
      scope: DELEGATED_REDEMPTION_SCOPES.join(' '),
      expires_in: expiresIn,
      ext_expires_in: expiresIn,
      access_token: options.accessToken,
      refresh_token: options.refreshToken,
      id_token: idToken(options.nonce === undefined ? {} : { nonce: options.nonce }),
      client_info: b64url(JSON.stringify({ uid: USER_OID, utid: TENANT_ID })),
    },
  };
}

/** A scripted Entra: discovery is answered for any tenant, token-endpoint
 *  POSTs are answered from a queue and recorded. */
function fakeEntra(replies: TokenReply[]) {
  const posts: Array<{ url: string; body: URLSearchParams }> = [];
  const networkClient: INetworkModule = {
    async sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
      const tenant = new URL(url).pathname.split('/')[1] ?? 'common';
      if (url.includes('/discovery/instance')) {
        return {
          status: 200,
          headers: {},
          body: {
            tenant_discovery_endpoint:
              `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
            'api-version': '1.1',
            metadata: [{
              preferred_network: 'login.microsoftonline.com',
              preferred_cache: 'login.windows.net',
              aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'],
            }],
          } as T,
        };
      }
      if (url.includes('openid-configuration')) {
        return {
          status: 200,
          headers: {},
          body: {
            token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
            authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
            end_session_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`,
            jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
            issuer: `https://login.microsoftonline.com/${tenant === 'common' ? '{tenantid}' : tenant}/v2.0`,
          } as T,
        };
      }
      throw new Error(`fake Entra: unexpected GET ${url}`);
    },
    async sendPostRequestAsync<T>(url: string, options?: { body?: string }): Promise<NetworkResponse<T>> {
      posts.push({ url, body: new URLSearchParams(options?.body ?? '') });
      const reply = replies.shift();
      if (!reply) throw new Error(`fake Entra: unexpected POST ${url}`);
      return { status: reply.status, headers: {}, body: reply.body as T };
    },
  };
  return { networkClient, posts };
}

function fixture(replies: TokenReply[]) {
  const entra = fakeEntra(replies);
  const keyring: KekKeyring = {
    writerVersion: KEK_V1,
    keys: new Map([[KEK_V1, new Uint8Array(Buffer.alloc(32, 9))]]),
  };
  const tokenCache = new DelegatedTokenCache({
    store: new InMemoryTokenCacheStore(), keyring, holderId: HOLDER, leaseAttempts: 2, sleep: async () => {},
  });
  const certificateProvider = {
    getConfiguredCertificate: vi.fn(async () => ({
      certificatePem: CERTIFICATE_PEM,
      privateKeyPem: PRIVATE_KEY_PEM,
    })),
  };
  // Raw MSAL errors, captured before the broker maps them to a code, so a
  // test can tell nonce_mismatch from any other credential_unavailable.
  const msalErrors: unknown[] = [];
  // The production configuration, plus only the fake network.
  const createConfidentialClient = ({ authority }: { authority: string }): ConfidentialClientPort => {
    const cca = new ConfidentialClientApplication({
      ...msalConfidentialClientConfiguration(
        { certificatePem: CERTIFICATE_PEM, privateKeyPem: PRIVATE_KEY_PEM }, CLIENT_ID, authority,
      ),
      system: { networkClient: entra.networkClient },
    }) as unknown as ConfidentialClientPort;
    const byCode = cca.acquireTokenByCode.bind(cca);
    cca.acquireTokenByCode = async (request) => {
      try {
        return await byCode(request);
      } catch (error) {
        msalErrors.push(error);
        throw error;
      }
    };
    return cca;
  };
  const broker = createDelegatedCredentialBroker(
    { clientId: CLIENT_ID, certificateProvider, tokenCache },
    { createConfidentialClient },
  );
  return { broker, tokenCache, posts: entra.posts, msalErrors };
}

async function consent(broker: ReturnType<typeof fixture>['broker']) {
  return broker.redeemConsentCode({
    authorizationCode: 'authorization-code',
    codeVerifier: 'pkce-code-verifier',
    redirectUri: REDIRECT_URI,
    nonce: NONCE,
  });
}

describe('delegated broker against real msal-node — consent redemption', () => {
  it('redeems an authorization code whose ID token echoes the session nonce', async () => {
    const { broker, posts } = fixture([
      tokenSuccess({ accessToken: 'consent-access', refreshToken: 'refresh-1', nonce: NONCE }),
    ]);

    const redemption = await consent(broker);

    expect(redemption.accessToken).toBe('consent-access');
    expect(redemption.accountTenantId).toBe(TENANT_ID);
    expect(redemption.accountUserObjectId).toBe(USER_OID);
    expect([...redemption.grantedScopes].sort()).toEqual([...DELEGATED_REDEMPTION_SCOPES].sort());
    expect(JSON.parse(redemption.serializedCache)).toHaveProperty('RefreshToken');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.get('grant_type')).toBe('authorization_code');
    expect(posts[0]!.body.get('code')).toBe('authorization-code');
    expect(posts[0]!.body.get('code_verifier')).toBe('pkce-code-verifier');
    expect(posts[0]!.body.get('client_assertion_type'))
      .toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });

  it('rejects an ID token whose nonce is not the session nonce', async () => {
    const { broker, msalErrors } = fixture([
      tokenSuccess({ accessToken: 'consent-access', refreshToken: 'refresh-1', nonce: 'replayed-nonce' }),
    ]);

    await expect(consent(broker)).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(msalErrors).toEqual([expect.objectContaining({ errorCode: 'nonce_mismatch' })]);
  });
});

/**
 * A token cache exactly as msal-node 6.0.0 (msal-common 16.14.0) serialized
 * it — the version that wrote every production row before #9925 forced the
 * 7.x major. Generated offline by running 6.0.0's acquireTokenByCode against
 * the same scripted Entra and fixture certificate; every secret is fake.
 * The ID token and client_info are rebuilt from their claims at runtime
 * (byte-identical to what 6.0.0 stored) so no token-shaped literal is
 * committed for secret scanners to flag.
 */
const V6_ISSUED_AT = 1767225600;
const MSAL_V6_SERIALIZED_CACHE = JSON.stringify({
  "Account": {
    "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333-login.windows.net-33333333-3333-4333-8333-333333333333": {
      "home_account_id": "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333",
      "environment": "login.windows.net",
      "realm": "33333333-3333-4333-8333-333333333333",
      "local_account_id": "44444444-4444-4444-8444-444444444444",
      "username": "user@contoso.example",
      "authority_type": "MSSTS",
      "name": "Fixture User",
      "client_info": b64url(JSON.stringify({ uid: USER_OID, utid: TENANT_ID })),
      "tenantProfiles": [
        "{\"tenantId\":\"33333333-3333-4333-8333-333333333333\",\"localAccountId\":\"44444444-4444-4444-8444-444444444444\",\"name\":\"Fixture User\",\"username\":\"user@contoso.example\",\"isHomeTenant\":true}"
      ]
    }
  },
  "IdToken": {
    "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333-login.windows.net-idtoken-c3333333-3333-4333-8333-333333333333-33333333-3333-4333-8333-333333333333--": {
      "home_account_id": "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333",
      "environment": "login.windows.net",
      "credential_type": "IdToken",
      "client_id": "c3333333-3333-4333-8333-333333333333",
      "secret": idToken({ iat: V6_ISSUED_AT, nbf: V6_ISSUED_AT, exp: V6_ISSUED_AT + 3600 }),
      "realm": "33333333-3333-4333-8333-333333333333"
    }
  },
  "AccessToken": {
    "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333-login.windows.net-accesstoken-c3333333-3333-4333-8333-333333333333-33333333-3333-4333-8333-333333333333-https://graph.microsoft.com/user.read https://graph.microsoft.com/mail.readwrite https://graph.microsoft.com/mail.send-": {
      "home_account_id": "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333",
      "environment": "login.windows.net",
      "credential_type": "AccessToken",
      "client_id": "c3333333-3333-4333-8333-333333333333",
      "secret": "v6-consent-access",
      "realm": "33333333-3333-4333-8333-333333333333",
      "target": "https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
      "cached_at": "1795032426",
      "expires_on": "1795036026",
      "extended_expires_on": "1795039626",
      "token_type": "Bearer"
    }
  },
  "RefreshToken": {
    "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333-login.windows.net-refreshtoken-c3333333-3333-4333-8333-333333333333---": {
      "home_account_id": "44444444-4444-4444-8444-444444444444.33333333-3333-4333-8333-333333333333",
      "environment": "login.windows.net",
      "credential_type": "RefreshToken",
      "client_id": "c3333333-3333-4333-8333-333333333333",
      "secret": "v6-refresh-1"
    }
  },
  "AppMetadata": {}
});

describe('delegated broker against real msal-node — durable cache round trip', () => {
  async function consented(replies: TokenReply[]) {
    const harness = fixture([
      tokenSuccess({ accessToken: 'consent-access', refreshToken: 'refresh-1', nonce: NONCE }),
      ...replies,
    ]);
    const redemption = await consent(harness.broker);
    await harness.tokenCache.writeConsentRow({
      connectionId: CONNECTION_A,
      consentAttemptId: ATTEMPT_ID,
      consentGeneration: 1,
      plaintext: redemption.serializedCache,
    });
    harness.posts.length = 0;
    return harness;
  }

  const acquireInput = {
    connectionId: CONNECTION_A,
    tenantId: TENANT_ID,
    expectedUserObjectId: USER_OID,
    consentGeneration: 1,
  };

  it('hydrates a fresh CCA from the row, finds the pinned account, and commits the rotated cache', async () => {
    const { broker, posts, tokenCache } = await consented([
      tokenSuccess({ accessToken: 'refreshed-access', refreshToken: 'refresh-2' }),
    ]);

    const acquisition = await broker.acquireForConnection(acquireInput);

    expect(acquisition).toEqual({
      accessToken: 'refreshed-access',
      tokenTenantId: TENANT_ID,
      tokenUserObjectId: USER_OID,
      usedCacheGeneration: 2,
      rotated: true,
    });
    // The silent request asks for '.default', which never matches the
    // consent access token's explicit scopes — so MSAL redeems the cached
    // refresh token on every acquisition rather than serving the cached AT.
    // Pinned here so a change in that behaviour is seen, not discovered.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(posts[0]!.body.get('refresh_token')).toBe('refresh-1');
    const reloaded = await tokenCache.withLease(CONNECTION_A, async (loaded) => loaded);
    expect(reloaded.plaintext).toContain('refresh-2');
    expect(reloaded.plaintext).not.toContain('refresh-1');
    expect(reloaded.cacheVersion).toBe(2);
  });

  it('maps an invalid_grant refresh failure to delegated_reauth_required and keeps the row', async () => {
    const { broker, tokenCache } = await consented([{
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'AADSTS70043: The refresh token has expired.',
        error_codes: [70043],
        suberror: 'bad_token',
      },
    }]);

    await expect(broker.acquireForConnection(acquireInput))
      .rejects.toMatchObject({ code: 'delegated_reauth_required' });
    const reloaded = await tokenCache.withLease(CONNECTION_A, async (loaded) => loaded);
    expect(reloaded.plaintext).toContain('refresh-1');
    expect(reloaded.cacheVersion).toBe(1);
  });

  it('re-serializes a msal-node 6.0.0 cache without changing it', () => {
    const cca = new ConfidentialClientApplication(msalConfidentialClientConfiguration(
      { certificatePem: CERTIFICATE_PEM, privateKeyPem: PRIVATE_KEY_PEM },
      CLIENT_ID,
      `https://login.microsoftonline.com/${TENANT_ID}`,
    ));

    cca.getTokenCache().deserialize(MSAL_V6_SERIALIZED_CACHE);

    expect(JSON.parse(cca.getTokenCache().serialize())).toEqual(JSON.parse(MSAL_V6_SERIALIZED_CACHE));
  });

  it('acquires from a row msal-node 6.0.0 wrote, redeeming its refresh token', async () => {
    const harness = fixture([
      tokenSuccess({ accessToken: 'refreshed-access', refreshToken: 'refresh-2' }),
    ]);
    await harness.tokenCache.writeConsentRow({
      connectionId: CONNECTION_A,
      consentAttemptId: ATTEMPT_ID,
      consentGeneration: 1,
      plaintext: MSAL_V6_SERIALIZED_CACHE,
    });

    const acquisition = await harness.broker.acquireForConnection(acquireInput);

    expect(acquisition).toMatchObject({
      accessToken: 'refreshed-access',
      tokenTenantId: TENANT_ID,
      tokenUserObjectId: USER_OID,
      rotated: true,
    });
    expect(harness.posts.map((post) => post.body.get('refresh_token'))).toEqual(['v6-refresh-1']);
  });
});
