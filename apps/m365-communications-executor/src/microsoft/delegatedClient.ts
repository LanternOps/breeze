import { X509Certificate } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { getM365PermissionProfile } from '@breeze/shared/m365';
import {
  DelegatedTokenCache,
  type LoadedCache,
} from '../credentials/delegatedTokenCache';
import type { PinnedCertificateProvider } from '../credentials/types';

/**
 * MSAL confidential-client broker over the fenced token cache (design §3.2,
 * §4.2). One ConfidentialClientApplication per request per connection
 * (decision 4 — no pooling), certificate assertion for client auth (PKCE is
 * not client auth).
 *
 * Divergence from the spec's `ICachePlugin` sketch, on purpose: the broker
 * hydrates the CCA's cache from the durable row via `deserialize` INSIDE the
 * lease, and after acquisition compares `serialize()` output — a change means
 * MSAL rotated, and the broker commits it through the CAS write. The §3.2
 * semantics (decrypt-load before access, encrypt-CAS-write after change) are
 * identical; only the invocation point moved to where the lease is held, so
 * rotation-commit outcomes (written/concurrent/superseded/tombstoned) are
 * handled explicitly instead of inside callbacks MSAL times itself.
 */

/** Branded so an access token can never be logged or embedded as a plain string by accident. */
declare const accessTokenBrand: unique symbol;
export type OpaqueAccessToken = string & { readonly [accessTokenBrand]: true };

const GRAPH_SILENT_SCOPES = ['https://graph.microsoft.com/.default'];

const OIDC_SCOPES = new Set(['openid', 'profile', 'offline_access']);

/** The Graph resource scopes from the v2 profile, fully qualified for the
 *  authorize/redeem legs. Derived, not hardcoded — the profile is the source
 *  of truth (a test pins the derived set). openid/profile/offline_access are
 *  OIDC scopes MSAL adds itself. */
export const DELEGATED_REDEMPTION_SCOPES = getM365PermissionProfile('communications-delegated')
  .delegatedPermissions
  .filter((scope) => !OIDC_SCOPES.has(scope))
  .map((scope) => `https://graph.microsoft.com/${scope}`);

export class DelegatedCredentialError extends Error {
  constructor(
    readonly code:
      | 'delegated_reauth_required'
      | 'credential_rotation_failed'
      | 'credential_unavailable'
      | 'identity_token_invalid'
      | 'binding_stale',
  ) {
    super(code);
    this.name = 'DelegatedCredentialError';
  }
}

export interface MsalAccountLike {
  homeAccountId?: string;
  idTokenClaims?: { tid?: unknown; oid?: unknown } & Record<string, unknown>;
}

export interface MsalAuthResultLike {
  accessToken?: string;
  idToken?: string;
  scopes?: string[];
  account?: MsalAccountLike | null;
}

export interface ConfidentialClientPort {
  acquireTokenSilent(request: {
    account: MsalAccountLike; scopes: string[]; authority: string; forceRefresh?: boolean;
  }): Promise<MsalAuthResultLike | null>;
  acquireTokenByCode(request: {
    code: string; redirectUri: string; codeVerifier: string; scopes: string[]; authority: string;
  }): Promise<MsalAuthResultLike | null>;
  getTokenCache(): {
    deserialize(blob: string): void;   // hydrate from the durable row
    serialize(): string;
    getAllAccounts(): Promise<MsalAccountLike[]>;
  };
}

export type ConfidentialClientFactory = (options: { authority: string }) => ConfidentialClientPort;

export interface DelegatedAcquisition {
  accessToken: OpaqueAccessToken;
  tokenTenantId: string;
  tokenUserObjectId: string;
  usedCacheGeneration: number;
  rotated: boolean;
}

export interface ConsentRedemption {
  rawIdToken: string;
  grantedScopes: readonly string[];
  accessToken: OpaqueAccessToken;
  serializedCache: string;
  accountTenantId: string | null;
  accountUserObjectId: string | null;
}

export interface AcquireInput {
  connectionId: string;
  tenantId: string;
  expectedUserObjectId: string;
  consentGeneration: number;
}

interface CertificateCredential {
  certificatePem: string;
  privateKeyPem: string;
}

function defaultFactory(credential: CertificateCredential, clientId: string): ConfidentialClientFactory {
  return ({ authority }) => new ConfidentialClientApplication({
    auth: {
      clientId,
      authority,
      clientCertificate: {
        thumbprintSha256: new X509Certificate(credential.certificatePem)
          .fingerprint256.replaceAll(':', ''),
        privateKey: credential.privateKeyPem,
      },
    },
  }) as unknown as ConfidentialClientPort;
}

/**
 * `invalid_grant` / interaction-required means the human must sign in again.
 * Never include `error.message` content in the thrown error — MSAL messages
 * can embed server text.
 */
function mapMsalError(error: unknown): DelegatedCredentialError {
  if (error instanceof DelegatedCredentialError) return error;
  const shaped = error as { name?: unknown; errorCode?: unknown; message?: unknown } | null;
  const name = typeof shaped?.name === 'string' ? shaped.name : '';
  const errorCode = typeof shaped?.errorCode === 'string' ? shaped.errorCode : '';
  const message = typeof shaped?.message === 'string' ? shaped.message : '';
  if (
    name === 'InteractionRequiredAuthError'
    || errorCode.includes('invalid_grant')
    || message.includes('invalid_grant')
  ) {
    return new DelegatedCredentialError('delegated_reauth_required');
  }
  return new DelegatedCredentialError('credential_unavailable');
}

export function createDelegatedCredentialBroker(
  config: {
    clientId: string;
    certificateProvider: PinnedCertificateProvider;
    tokenCache: DelegatedTokenCache;
  },
  dependencies: { createConfidentialClient?: ConfidentialClientFactory } = {},
): {
  acquireForConnection(input: AcquireInput): Promise<DelegatedAcquisition>;
  redeemConsentCode(input: {
    authorizationCode: string; codeVerifier: string; redirectUri: string;
  }): Promise<ConsentRedemption>;
} {
  async function fetchCertificate(): Promise<CertificateCredential> {
    try {
      return await config.certificateProvider.getConfiguredCertificate();
    } catch {
      throw new DelegatedCredentialError('credential_unavailable');
    }
  }

  function createClient(credential: CertificateCredential, options: { authority: string }): ConfidentialClientPort {
    const factory = dependencies.createConfidentialClient ?? defaultFactory(credential, config.clientId);
    return factory(options);
  }

  async function attempt(input: AcquireInput): Promise<DelegatedAcquisition | 'concurrent'> {
    return config.tokenCache.withLease(input.connectionId, async (loaded: LoadedCache) => {
      // §5.2: the binding check precedes everything — a stale generation must
      // not even fetch the certificate, let alone reach MSAL.
      if (loaded.consentGeneration !== input.consentGeneration) {
        throw new DelegatedCredentialError('binding_stale');
      }
      const credential = await fetchCertificate();
      try {
        const cca = createClient(credential, {
          authority: `https://login.microsoftonline.com/${input.tenantId}`,
        });
        cca.getTokenCache().deserialize(loaded.plaintext);
        const accounts = await cca.getTokenCache().getAllAccounts();
        const account = accounts.find((candidate) =>
          candidate.idTokenClaims?.oid === input.expectedUserObjectId
          && candidate.idTokenClaims?.tid === input.tenantId);
        if (!account) throw new DelegatedCredentialError('identity_token_invalid');

        let result: MsalAuthResultLike | null;
        try {
          result = await cca.acquireTokenSilent({
            account, scopes: GRAPH_SILENT_SCOPES,
            authority: `https://login.microsoftonline.com/${input.tenantId}`,
          });
        } catch (error) {
          throw mapMsalError(error);
        }
        if (!result?.accessToken) throw new DelegatedCredentialError('credential_unavailable');

        const serialized = cca.getTokenCache().serialize();
        let rotated = false;
        if (serialized !== loaded.plaintext) {
          const outcome = await config.tokenCache.commitRotation(
            input.connectionId, loaded, serialized,
          );
          if (outcome === 'concurrent') return 'concurrent';   // caller re-loads and retries once
          rotated = true;
        }
        return {
          accessToken: result.accessToken as OpaqueAccessToken,
          tokenTenantId: String(account.idTokenClaims?.tid ?? ''),
          tokenUserObjectId: String(account.idTokenClaims?.oid ?? ''),
          usedCacheGeneration: loaded.cacheVersion + (rotated ? 1 : 0),
          rotated,
        };
      } finally {
        credential.certificatePem = '';
        credential.privateKeyPem = '';
      }
    });
  }

  async function acquireForConnection(input: AcquireInput): Promise<DelegatedAcquisition> {
    const RETRIES = 2;   // initial + one 'concurrent' retry
    for (let round = 0; round < RETRIES; round++) {
      const outcome = await attempt(input);
      if (outcome !== 'concurrent') return outcome;
    }
    throw new DelegatedCredentialError('credential_rotation_failed');
  }

  async function redeemConsentCode(input: {
    authorizationCode: string; codeVerifier: string; redirectUri: string;
  }): Promise<ConsentRedemption> {
    // Fresh CCA with NO deserialize call — MSAL's default in-memory cache IS
    // the §4.2 throwaway. The durable store is not touched here at all: the
    // consent OPERATION commits the serialized cache only after every
    // identity and scope check passes.
    const credential = await fetchCertificate();
    try {
      const cca = createClient(credential, {
        authority: 'https://login.microsoftonline.com/common',
      });
      let result: MsalAuthResultLike | null;
      try {
        result = await cca.acquireTokenByCode({
          code: input.authorizationCode,
          redirectUri: input.redirectUri,
          codeVerifier: input.codeVerifier,
          scopes: DELEGATED_REDEMPTION_SCOPES,
          authority: 'https://login.microsoftonline.com/common',
        });
      } catch (error) {
        throw mapMsalError(error);
      }
      if (!result?.accessToken || !result.idToken) {
        throw new DelegatedCredentialError('credential_unavailable');
      }
      const claims = result.account?.idTokenClaims;
      return {
        rawIdToken: result.idToken,
        // §4.2: granted scopes come from AuthenticationResult.scopes — never
        // from parsing an `scp` claim out of the access token.
        grantedScopes: [...(result.scopes ?? [])],
        accessToken: result.accessToken as OpaqueAccessToken,
        serializedCache: cca.getTokenCache().serialize(),
        accountTenantId: typeof claims?.tid === 'string' ? claims.tid : null,
        accountUserObjectId: typeof claims?.oid === 'string' ? claims.oid : null,
      };
    } finally {
      credential.certificatePem = '';
      credential.privateKeyPem = '';
    }
  }

  return { acquireForConnection, redeemConsentCode };
}
