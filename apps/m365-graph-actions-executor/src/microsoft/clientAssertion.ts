import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSERTION_LIFETIME_SECONDS = 300;

export class ClientAssertionError extends Error {
  readonly code = 'client_assertion_failed' as const;

  constructor() {
    super('client_assertion_failed');
    this.name = 'ClientAssertionError';
  }
}

export const ORGANIZATIONS_AUTHORITY = 'organizations';

/**
 * A Microsoft identity-platform authority segment: a canonical lower-case
 * tenant GUID, or exactly `organizations` (multi-tenant work/school sign-in).
 * `organizations` is only meaningful for authorization-code redemption; the
 * token client refuses it for application (client-credentials) tokens.
 */
export type MicrosoftAuthority = 'organizations' | (string & {});

/** Returns the v2 token endpoint for a validated authority, else throws. */
export function tokenEndpointForAuthority(authority: MicrosoftAuthority): string {
  if (authority !== ORGANIZATIONS_AUTHORITY && !CANONICAL_UUID.test(authority)) {
    throw new ClientAssertionError();
  }
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
}

export async function createClientAssertion(input: {
  clientId: string;
  /** The assertion audience is the token endpoint of exactly this authority. */
  authority: MicrosoftAuthority;
  certificatePem: string;
  privateKeyPem: string;
  now?: Date;
}): Promise<string> {
  try {
    if (!CANONICAL_UUID.test(input.clientId)) throw new ClientAssertionError();
    const audience = tokenEndpointForAuthority(input.authority);
    const now = input.now ?? new Date();
    const issuedAt = Math.floor(now.getTime() / 1_000);
    if (!Number.isFinite(issuedAt)) throw new ClientAssertionError();

    const certificate = new X509Certificate(input.certificatePem);
    // `x5t` is the Microsoft-identity-platform-mandated SHA-1 X.509 certificate
    // thumbprint (RFC 7515 §4.1.7): an IDENTIFIER Azure AD uses to match the
    // registered certificate, not a security primitive. The assertion itself is
    // signed with RS256 below. SHA-1 is required here and cannot be substituted.
    // codeql[js/weak-cryptographic-algorithm]
    const x5t = createHash('sha1').update(certificate.raw).digest('base64url');
    const privateKey = await importPKCS8(input.privateKeyPem, 'RS256');

    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', x5t })
      .setIssuer(input.clientId)
      .setSubject(input.clientId)
      .setAudience(audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .sign(privateKey);
  } catch {
    throw new ClientAssertionError();
  }
}
