import { createHash, timingSafeEqual, type KeyObject } from 'node:crypto';
import { importJWK, jwtVerify, type CryptoKey, type JWK } from 'jose';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LIFETIME_SECONDS = 60;

export type ExecutorOperation = 'execute-action';

export interface InternalRequestAuthenticationInput {
  authorization: string | undefined;
  operation: ExecutorOperation;
  rawBody: Uint8Array;
}

export interface InternalRequestAuthentication {
  correlationId: string;
}

/** Allows EdDSA request auth to be replaced with workload identity later. */
export interface InternalRequestAuthenticator {
  verify(input: InternalRequestAuthenticationInput): Promise<InternalRequestAuthentication>;
}

export class InternalRequestAuthenticationError extends Error {
  readonly code = 'internal_request_unauthorized' as const;

  constructor() {
    super('internal_request_unauthorized');
    this.name = 'InternalRequestAuthenticationError';
  }
}

interface EdDsaAuthenticatorConfig {
  publicJwk: JWK;
  kid: string;
  currentDate?: () => Date;
}

function unauthorized(): InternalRequestAuthenticationError {
  return new InternalRequestAuthenticationError();
}

function exactBearerToken(value: string | undefined): string {
  if (!value || !value.startsWith('Bearer ')) throw unauthorized();
  const token = value.slice('Bearer '.length);
  if (!token || token.includes(' ') || token.includes('\t') || token.includes('\n')) {
    throw unauthorized();
  }
  return token;
}

function bodyDigest(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('base64url');
}

function digestMatches(actual: string, claimed: unknown): boolean {
  if (typeof claimed !== 'string' || !BODY_DIGEST.test(claimed)) return false;
  const actualBytes = Buffer.from(actual, 'base64url');
  const claimedBytes = Buffer.from(claimed, 'base64url');
  return actualBytes.length === claimedBytes.length && timingSafeEqual(actualBytes, claimedBytes);
}

export async function createEdDsaInternalRequestAuthenticator(
  config: EdDsaAuthenticatorConfig,
): Promise<InternalRequestAuthenticator> {
  let verificationKey: CryptoKey | KeyObject | Uint8Array;
  try {
    verificationKey = await importJWK(config.publicJwk, 'EdDSA');
  } catch {
    throw unauthorized();
  }

  return {
    async verify(input) {
      try {
        const token = exactBearerToken(input.authorization);
        const currentDate = config.currentDate?.() ?? new Date();
        const { payload, protectedHeader } = await jwtVerify(token, verificationKey, {
          algorithms: ['EdDSA'],
          issuer: 'breeze-api',
          audience: 'm365-graph-actions-executor',
          subject: 'breeze-control-plane',
          currentDate,
          requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
        });
        if (
          protectedHeader.kid !== config.kid
          || payload.iss !== 'breeze-api'
          || payload.aud !== 'm365-graph-actions-executor'
          || payload.sub !== 'breeze-control-plane'
          || !Number.isSafeInteger(payload.iat)
          || !Number.isSafeInteger(payload.exp)
          || (payload.exp as number) <= (payload.iat as number)
          || (payload.exp as number) - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
          || (payload.iat as number) > Math.floor(currentDate.getTime() / 1_000)
          || Math.floor(currentDate.getTime() / 1_000) - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
          || typeof payload.jti !== 'string'
          || !UUID.test(payload.jti)
          || payload.operation !== input.operation
          || typeof payload.correlationId !== 'string'
          || !UUID.test(payload.correlationId)
          || !digestMatches(bodyDigest(input.rawBody), payload.bodySha256)
        ) {
          throw unauthorized();
        }
        return { correlationId: payload.correlationId };
      } catch {
        throw unauthorized();
      }
    },
  };
}
