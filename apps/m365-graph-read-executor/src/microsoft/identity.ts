import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type KeyObject,
} from 'jose';
import type { OpaqueIdentityToken } from './tokenClient';

export const GLOBAL_ADMIN_ROLE_ID = '62e90394-69f5-4237-9190-012177145e10';
export const PRIVILEGED_ROLE_ADMIN_ROLE_ID = 'e8611ab8-c189-46e8-94e1-60213ab1f814';

const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const MICROSOFT_JWKS_URL = `${MICROSOFT_LOGIN_ORIGIN}/common/discovery/v2.0/keys`;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTED_ADMIN_ROLES = new Set([
  GLOBAL_ADMIN_ROLE_ID,
  PRIVILEGED_ROLE_ADMIN_ROLE_ID,
]);

export type MicrosoftIdentityFailureCode =
  | 'identity_token_invalid'
  | 'tenant_mismatch'
  | 'admin_role_required';

export class MicrosoftIdentityFailure extends Error {
  override readonly name = 'MicrosoftIdentityFailure';

  constructor(readonly code: MicrosoftIdentityFailureCode) {
    super(code);
  }
}

export interface VerifiedMicrosoftAdminIdentity {
  tenantId: string;
  administratorObjectId: string;
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

export async function verifyMicrosoftAdminIdentity(
  idToken: OpaqueIdentityToken,
  expected: { tenantHint: string; clientId: string; nonce: string },
  dependencies: VerificationDependencies = {},
): Promise<VerifiedMicrosoftAdminIdentity> {
  if (
    !canonicalExpectedGuid(expected.tenantHint)
    || !canonicalExpectedGuid(expected.clientId)
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
      requiredClaims: ['iss', 'aud', 'sub', 'tid', 'oid', 'nonce', 'wids', 'exp', 'nbf'],
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
  const administratorObjectId = canonicalClaimGuid(payload.oid);
  const expectedIssuer = tenantId
    ? `${MICROSOFT_LOGIN_ORIGIN}/${tenantId}/v2.0`
    : undefined;
  const roles = Array.isArray(payload.wids)
    && payload.wids.every((role: unknown) => typeof role === 'string')
    ? payload.wids as string[]
    : undefined;

  if (
    !tenantId
    || !administratorObjectId
    || payload.iss !== expectedIssuer
    || payload.aud !== expected.clientId
    || typeof payload.sub !== 'string'
    || payload.sub.length === 0
    || payload.nonce !== expected.nonce
    || !Number.isSafeInteger(payload.exp)
    || !Number.isSafeInteger(payload.nbf)
    || !roles
  ) {
    throw failure('identity_token_invalid');
  }

  if (tenantId !== expected.tenantHint) throw failure('tenant_mismatch');
  if (!roles.some((role) => ACCEPTED_ADMIN_ROLES.has(role.toLowerCase()))) {
    throw failure('admin_role_required');
  }

  return { tenantId, administratorObjectId };
}
