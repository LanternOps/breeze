import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { partners, partnerServicePrincipalKeys, partnerServicePrincipals, users } from '../db/schema';
import { ipMatchesAny, isValidIpOrCidr } from './ipMatch';
import {
  authorizePartnerServicePrincipalOwner,
  type PartnerServicePrincipalSurface,
} from './partnerServicePrincipalOwnerAuthority';
import {
  PARTNER_SERVICE_PRINCIPAL_MCP_READ_REQUIRED_ERROR,
  type PartnerServicePrincipalMcpScope,
  type PartnerServicePrincipalScope,
  partnerServicePrincipalMcpScopes,
  partnerServicePrincipalMcpScopesMissingRead,
  validatePartnerServicePrincipalScopes,
} from './partnerServicePrincipalScopes';
import { assertActiveTenantContext, TenantInactiveError } from './tenantStatus';

/**
 * Partner service principal (`brz_sp_`) authentication, shared by the
 * Partner API (middleware/partnerApiAuth.ts) and the MCP endpoint
 * (middleware/partnerServicePrincipalMcpAuth.ts, reached through
 * routes/mcpServer.ts) so both surfaces enforce one credential lifecycle AND
 * one owner check. The only exported way to accept a key is
 * {@link authenticatePartnerServicePrincipalKey}, which always re-checks the
 * owner's live authority; the bare lookup is module-private on purpose.
 * Kept free of the services barrel so the MCP route's import graph stays
 * small.
 */

export interface PartnerServicePrincipalCredentialFields {
  partnerServicePrincipalId: string;
  keyId: string;
  partnerId: string;
  name: string;
  scopes: PartnerServicePrincipalScope[];
  rateLimit: number;
  principalExpiresAt?: Date | string | null;
  sourceCidrs?: string[];
}

/**
 * A validated credential plus the principal's owner
 * (`partner_service_principals.created_by`) and the user who issued this key
 * (`partner_service_principal_keys.created_by`).
 */
interface LoadedPartnerServicePrincipalCredential {
  credential: PartnerServicePrincipalCredentialFields;
  ownerUserId: string;
  keyIssuedBy: string;
}

export type { PartnerServicePrincipalSurface };

/**
 * A key accepted for one surface. Neither the owner nor the owner's org list
 * is part of the Partner API context. Over MCP the owner is the accountable
 * human whose live RBAC bounds the principal's per-tool authority, and
 * `ownerOrgIds` is the reach of the owner's partner membership.
 */
export interface AuthenticatedPartnerServicePrincipal {
  credential: PartnerServicePrincipalCredentialFields;
  ownerUserId: string;
  /** Orgs the owner's partner membership reaches; [] for a platform-admin owner. */
  ownerOrgIds: string[];
  /** The principal's MCP (ai:*) scopes, in stored order. */
  mcpScopes: PartnerServicePrincipalMcpScope[];
}

const PARTNER_SERVICE_PRINCIPAL_KEY_PATTERN = /^brz_sp_[A-Za-z0-9_-]{43}$/;
const INVALID_CREDENTIALS_MESSAGE = 'Invalid partner API credentials';

/**
 * True when `rawKey` has the exact shape of a partner service principal key
 * (`brz_sp_` + 43 base64url chars). Organization keys are `brz_` + 32
 * base64url chars and can start with `sp_`, so routing on the prefix alone
 * would misroute roughly 1 in 262,144 org keys; the full-length match cannot.
 */
export function isPartnerServicePrincipalKeyFormat(rawKey: string): boolean {
  return PARTNER_SERVICE_PRINCIPAL_KEY_PATTERN.test(rawKey);
}

export function hashPartnerApiKey(rawKey: string): string {
  // Service-principal keys are generated high-entropy tokens. Persist and
  // compare only their SHA-256 digest; never include plaintext or digest in
  // errors, logs, context, or audit payloads.
  // lgtm[js/insufficient-password-hash]
  return createHash('sha256').update(rawKey).digest('hex');
}

function invalidCredentials(): HTTPException {
  return new HTTPException(401, { message: INVALID_CREDENTIALS_MESSAGE });
}

function isExpired(value: Date | string | null | undefined, now: number): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now;
}

/**
 * Look up and validate a key by its SHA-256 digest: key active and
 * unexpired, principal active and unexpired, owning partner active and not
 * deleted, the owner's credential and MFA epochs unchanged since the key was
 * issued, stored scopes valid, and the source-CIDR allowlist (when set)
 * matching the trusted client IP. Every failure throws the same generic 401,
 * so a caller cannot tell a revoked key from a disabled principal or an
 * unknown key. Nothing is cached.
 *
 * This does NOT check the owner's role, membership or org access, so it is
 * never exported: {@link authenticatePartnerServicePrincipalKey} is the only
 * caller.
 */
async function loadPartnerServicePrincipalCredential(
  keyHash: string,
  trustedClientIp: string | undefined,
): Promise<LoadedPartnerServicePrincipalCredential> {
  return withSystemDbAccessContext(async () => {
    const [credential] = await db
      .select({
        keyId: partnerServicePrincipalKeys.id,
        keyStatus: partnerServicePrincipalKeys.status,
        keyExpiresAt: partnerServicePrincipalKeys.expiresAt,
        keyCreatedBy: partnerServicePrincipalKeys.createdBy,
        keyOwnerCredentialEpoch: partnerServicePrincipalKeys.ownerCredentialEpoch,
        keyOwnerMfaEpoch: partnerServicePrincipalKeys.ownerMfaEpoch,
        rateLimit: partnerServicePrincipalKeys.rateLimit,
        partnerServicePrincipalId: partnerServicePrincipals.id,
        partnerId: partnerServicePrincipals.partnerId,
        name: partnerServicePrincipals.name,
        principalCreatedBy: partnerServicePrincipals.createdBy,
        principalStatus: partnerServicePrincipals.status,
        principalExpiresAt: partnerServicePrincipals.expiresAt,
        scopes: partnerServicePrincipals.scopes,
        sourceCidrs: partnerServicePrincipals.sourceCidrs,
        partnerStatus: partners.status,
        partnerDeletedAt: partners.deletedAt,
        ownerStatus: users.status,
        ownerCredentialEpoch: users.credentialEpoch,
        ownerMfaEpoch: users.mfaEpoch,
      })
      .from(partnerServicePrincipalKeys)
      .innerJoin(
        partnerServicePrincipals,
        and(
          eq(partnerServicePrincipals.id, partnerServicePrincipalKeys.partnerServicePrincipalId),
          eq(partnerServicePrincipals.partnerId, partnerServicePrincipalKeys.partnerId),
        ),
      )
      .innerJoin(partners, eq(partners.id, partnerServicePrincipals.partnerId))
      .innerJoin(users, eq(users.id, partnerServicePrincipals.createdBy))
      .where(eq(partnerServicePrincipalKeys.keyHash, keyHash))
      .limit(1);

    const now = Date.now();
    if (
      !credential
      || credential.keyStatus !== 'active'
      || isExpired(credential.keyExpiresAt, now)
      || credential.principalStatus !== 'active'
      || isExpired(credential.principalExpiresAt, now)
      || credential.partnerStatus !== 'active'
      || credential.partnerDeletedAt
      // Bound to the owner's credential state, like a human API key
      // (middleware/apiKeyAuth.ts): the owner's password change/reset, invite
      // acceptance or admin status change (credential_epoch), or an MFA factor
      // change (mfa_epoch), ends every key issued before it. Ordinary logout
      // advances only auth_epoch and does not (services/authLifecycle.ts).
      // A disabled owner also ends them directly, independent of which
      // epochs the disabling path advanced.
      || credential.ownerStatus !== 'active'
      || typeof credential.keyOwnerCredentialEpoch !== 'number'
      || typeof credential.keyOwnerMfaEpoch !== 'number'
      || credential.keyOwnerCredentialEpoch !== credential.ownerCredentialEpoch
      || credential.keyOwnerMfaEpoch !== credential.ownerMfaEpoch
    ) {
      throw invalidCredentials();
    }

    const validatedScopes = validatePartnerServicePrincipalScopes(credential.scopes);
    if (!validatedScopes.ok) {
      throw invalidCredentials();
    }

    const sourceCidrs = credential.sourceCidrs ?? [];
    if (sourceCidrs.some((entry) => !isValidIpOrCidr(entry))) {
      throw invalidCredentials();
    }
    if (
      sourceCidrs.length > 0
      && (!trustedClientIp || !ipMatchesAny(trustedClientIp, sourceCidrs))
    ) {
      // A configured allowlist is authoritative. If proxy trust cannot
      // resolve one canonical client address, fail closed.
      throw invalidCredentials();
    }

    return {
      credential: {
        partnerServicePrincipalId: credential.partnerServicePrincipalId,
        keyId: credential.keyId,
        partnerId: credential.partnerId,
        name: credential.name,
        scopes: validatedScopes.scopes,
        rateLimit: credential.rateLimit,
        principalExpiresAt: credential.principalExpiresAt,
        sourceCidrs,
      },
      ownerUserId: credential.principalCreatedBy,
      keyIssuedBy: credential.keyCreatedBy,
    };
  });
}

/**
 * Accept a partner service principal key for one surface, or throw.
 *
 * Credential checks first (see the module-private lookup: every failure is
 * the same generic 401). Over MCP the key must be one its owner issued, the
 * principal must hold an MCP scope including ai:read, and the partner must
 * pass the same strict tenant gate a partner-scope OAuth bearer passes. Then,
 * on both surfaces, the owner's live authority. Nothing is
 * cached: revocation, disable and an owner's demotion take effect on the next
 * request. The owner check is services/partnerServicePrincipalOwnerAuthority.ts.
 */
export async function authenticatePartnerServicePrincipalKey(
  keyHash: string,
  trustedClientIp: string | undefined,
  surface: PartnerServicePrincipalSurface,
): Promise<AuthenticatedPartnerServicePrincipal> {
  const { credential, ownerUserId, keyIssuedBy } = await loadPartnerServicePrincipalCredential(
    keyHash,
    trustedClientIp,
  );
  const mcpScopes = partnerServicePrincipalMcpScopes(credential.scopes);

  if (surface === 'mcp') {
    // Over MCP the key acts with its owner's role, so it must be one the owner
    // issued. Keys another admin issued before issuance became owner-only keep
    // working on the Partner API (where the principal acts as itself, still
    // bounded by its owner below) but are refused here; the owner rotates them
    // to restore MCP access.
    if (keyIssuedBy !== ownerUserId) {
      throw invalidCredentials();
    }
    if (mcpScopes.length === 0) {
      throw new HTTPException(403, { message: 'Partner service principal is not granted MCP access' });
    }
    if (partnerServicePrincipalMcpScopesMissingRead(mcpScopes)) {
      throw new HTTPException(403, { message: PARTNER_SERVICE_PRINCIPAL_MCP_READ_REQUIRED_ERROR });
    }
    try {
      await assertActiveTenantContext(
        { scope: 'partner', partnerId: credential.partnerId, orgId: null },
        { strictForOauth: true },
      );
    } catch (err) {
      if (err instanceof TenantInactiveError) {
        throw new HTTPException(401, { message: 'tenant inactive' });
      }
      throw err;
    }
  }

  const mcpScopeSet = new Set<string>(mcpScopes);
  const { orgIds } = await authorizePartnerServicePrincipalOwner({
    ownerUserId,
    partnerId: credential.partnerId,
    surface,
    scopes: surface === 'mcp'
      ? mcpScopes
      : credential.scopes.filter((scope) => !mcpScopeSet.has(scope)),
  });

  return { credential, ownerUserId, ownerOrgIds: orgIds, mcpScopes };
}
