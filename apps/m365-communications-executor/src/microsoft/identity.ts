import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type KeyObject,
} from 'jose';

const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const MICROSOFT_JWKS_URL = `${MICROSOFT_LOGIN_ORIGIN}/common/discovery/v2.0/keys`;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MicrosoftIdentityFailureCode =
  | 'identity_token_invalid'
  | 'tenant_mismatch';

export class MicrosoftIdentityFailure extends Error {
  override readonly name = 'MicrosoftIdentityFailure';

  constructor(readonly code: MicrosoftIdentityFailureCode) {
    super(code);
  }
}

export interface VerifiedDelegatedUserIdentity {
  tenantId: string;
  userObjectId: string;
}

interface VerificationDependencies {
  verificationKey?: CryptoKey | KeyObject;
  currentDate?: Date;
}

const microsoftJwks = createRemoteJWKSet(new URL(MICROSOFT_JWKS_URL), {
  cacheMaxAge: 10 * 60 * 1_000,
  cooldownDuration: 30 * 1_000,
});

function failure(code: MicrosoftIdentityFailureCode): MicrosoftIdentityFailure {
  return new MicrosoftIdentityFailure(code);
}

function canonicalExpectedGuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

function canonicalClaimGuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

/**
 * The delegated variant of the sibling admin identity gate (design §4.2).
 * Two deliberate deltas from the app-only clone:
 *
 * - No `tenantHint` pre-check: on first consent the tenant is LEARNED from the
 *   validated ID token, not hinted. `expected.expectedTenantId` is null on
 *   first consent; on reconnect a different returned `tid` is refused with
 *   `tenant_mismatch` BEFORE anything persists — otherwise reconnect is a
 *   mailbox-substitution primitive (§4.2 step 4).
 * - No `wids`/admin-role requirement: a delegated user is a named human, not
 *   an administrator; a token with no `wids` claim verifies.
 */
export async function verifyDelegatedUserIdentity(
  idToken: string,
  expected: { clientId: string; nonce: string; expectedTenantId: string | null },
  dependencies: VerificationDependencies = {},
): Promise<VerifiedDelegatedUserIdentity> {
  if (
    !canonicalExpectedGuid(expected.clientId)
    || (expected.expectedTenantId !== null && !canonicalExpectedGuid(expected.expectedTenantId))
    || typeof expected.nonce !== 'string'
    || expected.nonce.length === 0
    || typeof idToken !== 'string'
    || idToken.length === 0
  ) {
    throw failure('identity_token_invalid');
  }

  let payload: JWTPayload;
  try {
    const options = {
      algorithms: ['RS256'],
      audience: expected.clientId,
      currentDate: dependencies.currentDate,
      requiredClaims: ['iss', 'aud', 'sub', 'tid', 'oid', 'nonce', 'exp', 'nbf'],
    };
    if (dependencies.verificationKey) {
      ({ payload } = await jwtVerify(idToken, dependencies.verificationKey, options));
    } else {
      ({ payload } = await jwtVerify(idToken, microsoftJwks, options));
    }
  } catch {
    throw failure('identity_token_invalid');
  }

  const tenantId = canonicalClaimGuid(payload.tid);
  const userObjectId = canonicalClaimGuid(payload.oid);
  // The issuer is derived from the token's OWN tid — the tenant is learned,
  // then proven self-consistent, rather than asserted from outside.
  const expectedIssuer = tenantId
    ? `${MICROSOFT_LOGIN_ORIGIN}/${tenantId}/v2.0`
    : undefined;

  if (
    !tenantId
    || !userObjectId
    || payload.iss !== expectedIssuer
    || payload.aud !== expected.clientId
    || typeof payload.sub !== 'string'
    || payload.sub.length === 0
    || payload.nonce !== expected.nonce
    || !Number.isSafeInteger(payload.exp)
    || !Number.isSafeInteger(payload.nbf)
  ) {
    throw failure('identity_token_invalid');
  }

  if (expected.expectedTenantId !== null && tenantId !== expected.expectedTenantId) {
    throw failure('tenant_mismatch');
  }

  return { tenantId, userObjectId };
}
