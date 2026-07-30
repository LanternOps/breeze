import { describe, expect, it, vi } from 'vitest';
import { DelegatedTokenCache } from '../credentials/delegatedTokenCache';
import { InMemoryTokenCacheStore } from '../credentials/inMemoryTokenCacheStore';
import type { KekKeyring } from '../credentials/tokenCacheCrypto';
import {
  DELEGATED_REDEMPTION_SCOPES,
  DelegatedCredentialError,
  createDelegatedCredentialBroker,
  type ConfidentialClientPort,
  type MsalAccountLike,
} from './delegatedClient';

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CONNECTION_A = '11111111-1111-4111-8111-111111111111';
const CONNECTION_B = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_OID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const HOLDER = '66666666-6666-4666-8666-666666666666';
const KEK_V1 = 'a'.repeat(32);

const ACCOUNT: MsalAccountLike = {
  homeAccountId: 'home-account',
  idTokenClaims: { tid: TENANT_ID, oid: USER_OID },
};

interface StubCcaOptions {
  accounts?: MsalAccountLike[];
  silentResult?: { accessToken?: string } | null;
  silentError?: unknown;
  serializeAfterSilent?: string;
  byCodeResult?: {
    idToken?: string;
    accessToken?: string;
    scopes?: string[];
    account?: MsalAccountLike | null;
  } | null;
  byCodeError?: unknown;
  serialized?: string;
}

interface StubCca extends ConfidentialClientPort {
  deserializedBlobs: string[];
  authority: string;
}

function makeStubCca(authority: string, options: StubCcaOptions): StubCca {
  const deserializedBlobs: string[] = [];
  let serialized = options.serialized ?? '';
  let silentCalled = false;
  return {
    authority,
    deserializedBlobs,
    async acquireTokenSilent() {
      if (options.silentError !== undefined) throw options.silentError;
      silentCalled = true;
      return options.silentResult === undefined ? { accessToken: 'access-token' } : options.silentResult;
    },
    async acquireTokenByCode() {
      if (options.byCodeError !== undefined) throw options.byCodeError;
      return options.byCodeResult === undefined
        ? { idToken: 'raw-id-token', accessToken: 'consent-access', scopes: ['Mail.Send'], account: ACCOUNT }
        : options.byCodeResult;
    },
    getTokenCache() {
      return {
        deserialize(blob: string) {
          deserializedBlobs.push(blob);
          serialized = blob;
        },
        serialize() {
          if (silentCalled && options.serializeAfterSilent !== undefined) {
            return options.serializeAfterSilent;
          }
          return serialized;
        },
        async getAllAccounts() {
          return options.accounts ?? [ACCOUNT];
        },
      };
    },
  };
}

function fixture(options: StubCcaOptions = {}) {
  const store = new InMemoryTokenCacheStore();
  const keyring: KekKeyring = {
    writerVersion: KEK_V1,
    keys: new Map([[KEK_V1, new Uint8Array(Buffer.alloc(32, 9))]]),
  };
  const tokenCache = new DelegatedTokenCache({
    store, keyring, holderId: HOLDER, leaseAttempts: 2, sleep: async () => {},
  });
  const certificateProvider = {
    getConfiguredCertificate: vi.fn(async () => ({
      certificatePem: 'CERTIFICATE',
      privateKeyPem: 'PRIVATE-KEY',
    })),
  };
  const created: StubCca[] = [];
  const factory = vi.fn(({ authority }: { authority: string }) => {
    const cca = makeStubCca(authority, options);
    created.push(cca);
    return cca;
  });
  const broker = createDelegatedCredentialBroker(
    { clientId: CLIENT_ID, certificateProvider, tokenCache },
    { createConfidentialClient: factory },
  );
  return { store, tokenCache, certificateProvider, factory, created, broker };
}

async function seed(
  tokenCache: DelegatedTokenCache,
  connectionId = CONNECTION_A,
  plaintext = 'cache-blob-1',
  consentGeneration = 1,
) {
  return tokenCache.writeConsentRow({
    connectionId, consentAttemptId: ATTEMPT_ID, consentGeneration, plaintext,
  });
}

function acquireInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_A,
    tenantId: TENANT_ID,
    expectedUserObjectId: USER_OID,
    consentGeneration: 1,
    ...overrides,
  };
}

describe('delegated credential broker — acquireForConnection', () => {
  it('hydrates the CCA from the cache row and returns a token for the pinned account', async () => {
    const { tokenCache, broker, created, factory } = fixture({
      silentResult: { accessToken: 'silent-token' },
    });
    await seed(tokenCache);

    const acquisition = await broker.acquireForConnection(acquireInput());

    expect(acquisition).toEqual({
      accessToken: 'silent-token',
      tokenTenantId: TENANT_ID,
      tokenUserObjectId: USER_OID,
      usedCacheGeneration: 1,
      rotated: false,
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    });
    expect(created[0]!.deserializedBlobs).toEqual(['cache-blob-1']);
  });

  it('commits a rotated cache and reports rotated: true', async () => {
    const { tokenCache, broker } = fixture({ serializeAfterSilent: 'cache-blob-2' });
    await seed(tokenCache);

    const acquisition = await broker.acquireForConnection(acquireInput());

    expect(acquisition.rotated).toBe(true);
    expect(acquisition.usedCacheGeneration).toBe(2);
    const reloaded = await tokenCache.withLease(CONNECTION_A, async (loaded) => loaded);
    expect(reloaded.plaintext).toBe('cache-blob-2');
    expect(reloaded.cacheVersion).toBe(2);
  });

  it.each([
    ['an invalid_grant errorCode', { errorCode: 'invalid_grant' }],
    ['an InteractionRequiredAuthError name', Object.assign(new Error('interaction_required'), { name: 'InteractionRequiredAuthError' })],
  ])('maps %s to delegated_reauth_required without writing the store', async (_label, silentError) => {
    const { tokenCache, broker } = fixture({ silentError, serializeAfterSilent: 'poisoned' });
    await seed(tokenCache);

    await expect(broker.acquireForConnection(acquireInput()))
      .rejects.toMatchObject({ code: 'delegated_reauth_required' });
    const reloaded = await tokenCache.withLease(CONNECTION_A, async (loaded) => loaded);
    expect(reloaded.plaintext).toBe('cache-blob-1');
    expect(reloaded.cacheVersion).toBe(1);
  });

  it('refuses when no cached account matches the pinned oid/tid', async () => {
    const { tokenCache, broker } = fixture({
      accounts: [{ homeAccountId: 'other', idTokenClaims: { tid: TENANT_ID, oid: CONNECTION_B } }],
    });
    await seed(tokenCache);

    await expect(broker.acquireForConnection(acquireInput()))
      .rejects.toMatchObject({ code: 'identity_token_invalid' });
  });

  it('refuses a generation mismatch before any MSAL call', async () => {
    const { tokenCache, broker, factory, certificateProvider } = fixture();
    await seed(tokenCache, CONNECTION_A, 'cache-blob-1', 2);

    await expect(broker.acquireForConnection(acquireInput({ consentGeneration: 1 })))
      .rejects.toMatchObject({ code: 'binding_stale' });
    expect(factory).not.toHaveBeenCalled();
    expect(certificateProvider.getConfiguredCertificate).not.toHaveBeenCalled();
  });

  it('retries once on concurrent rotation commit', async () => {
    const { tokenCache, broker, factory } = fixture({ serializeAfterSilent: 'cache-blob-2' });
    await seed(tokenCache);
    const commitSpy = vi.spyOn(tokenCache, 'commitRotation');
    commitSpy.mockResolvedValueOnce('concurrent');

    const acquisition = await broker.acquireForConnection(acquireInput());

    expect(acquisition.rotated).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  it('two connections never share a client instance', async () => {
    const { tokenCache, broker, factory, created } = fixture();
    await seed(tokenCache, CONNECTION_A, 'blob-for-A');
    await seed(tokenCache, CONNECTION_B, 'blob-for-B');

    await broker.acquireForConnection(acquireInput({ connectionId: CONNECTION_A }));
    await broker.acquireForConnection(acquireInput({ connectionId: CONNECTION_B }));
    await broker.acquireForConnection(acquireInput({ connectionId: CONNECTION_A }));

    // One CCA per call per connection (decision 4: per-request CCA, no pooling)…
    expect(factory).toHaveBeenCalledTimes(3);
    // …and each CCA only ever saw its own row's blob.
    expect(created.map((cca) => cca.deserializedBlobs)).toEqual([
      ['blob-for-A'], ['blob-for-B'], ['blob-for-A'],
    ]);
  });
});

describe('delegated credential broker — redeemConsentCode', () => {
  it('never touches the durable store (the §4.2 ephemeral-cache mechanism)', async () => {
    const { store, broker, factory, created } = fixture({
      byCodeResult: {
        idToken: 'raw-id-token',
        accessToken: 'consent-access',
        scopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
        account: ACCOUNT,
      },
      serialized: 'redeemed-cache',
    });
    const readSpy = vi.spyOn(store, 'read');
    const putSpy = vi.spyOn(store, 'putConsentRow');
    const casSpy = vi.spyOn(store, 'casWrite');
    const leaseSpy = vi.spyOn(store, 'acquireLease');

    const redemption = await broker.redeemConsentCode({
      authorizationCode: 'auth-code',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://console.example.test/api/v1/m365/comms-consent/callback',
    });

    expect(redemption).toEqual({
      rawIdToken: 'raw-id-token',
      grantedScopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
      accessToken: 'consent-access',
      serializedCache: 'redeemed-cache',
      accountTenantId: TENANT_ID,
      accountUserObjectId: USER_OID,
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({ authority: 'https://login.microsoftonline.com/common' });
    // The throwaway in-memory MSAL cache IS the mechanism: no deserialize, no store I/O.
    expect(created[0]!.deserializedBlobs).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
    expect(casSpy).not.toHaveBeenCalled();
    expect(leaseSpy).not.toHaveBeenCalled();
  });

  it('maps provider rejection to credential_unavailable and invalid_grant to delegated_reauth_required', async () => {
    const generic = fixture({ byCodeError: new Error('AADSTS900023: something detailed') });
    await expect(generic.broker.redeemConsentCode({
      authorizationCode: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://x.example/cb',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });

    const invalidGrant = fixture({ byCodeError: { errorCode: 'invalid_grant' } });
    await expect(invalidGrant.broker.redeemConsentCode({
      authorizationCode: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://x.example/cb',
    })).rejects.toMatchObject({ code: 'delegated_reauth_required' });
  });
});

describe('DELEGATED_REDEMPTION_SCOPES', () => {
  it('derives the fully-qualified Graph resource scopes from profile v2', () => {
    // Derived, not hardcoded — the profile is the source of truth. A future
    // profile v3 changes this expectation loudly.
    expect(DELEGATED_REDEMPTION_SCOPES).toEqual([
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ]);
  });
});

describe('DelegatedCredentialError', () => {
  it('carries only enum words in its message', () => {
    const error = new DelegatedCredentialError('credential_unavailable');
    expect(error.message).toBe('credential_unavailable');
    expect(error.name).toBe('DelegatedCredentialError');
  });
});
