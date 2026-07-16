import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withResolvedDbAccessContext,
  withSystemDbAccessContext,
} from '../db';
import {
  organizations,
  partners,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
} from '../db/schema';
import { getRedis, rateLimiter } from '../services';
import { writeAuditEventAsync } from '../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { ipMatchesAny, isValidIpOrCidr } from '../services/ipMatch';
import {
  type PartnerServicePrincipalScope,
  validatePartnerServicePrincipalScopes,
} from '../services/partnerServicePrincipalScopes';
import { enforcePreLookupProbeRateLimit } from './apiKeyAuth';

export interface PartnerApiPrincipalContext {
  partnerServicePrincipalId: string;
  keyId: string;
  partnerId: string;
  name: string;
  scopes: PartnerServicePrincipalScope[];
  accessibleOrgIds: string[];
  rateLimit: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    partnerApiPrincipal: PartnerApiPrincipalContext;
  }
}

type CredentialBootstrap = Omit<PartnerApiPrincipalContext, 'accessibleOrgIds'>;

const PARTNER_API_KEY_PATTERN = /^brz_sp_[A-Za-z0-9_-]{43}$/;
const AUTH_REQUIRED_MESSAGE = 'Partner API authentication required';
const INVALID_CREDENTIALS_MESSAGE = 'Invalid partner API credentials';

function invalidCredentials(): HTTPException {
  return new HTTPException(401, { message: INVALID_CREDENTIALS_MESSAGE });
}

function hashPartnerApiKey(rawKey: string): string {
  // Service-principal keys are generated high-entropy tokens. Persist and
  // compare only their SHA-256 digest; never include plaintext or digest in
  // errors, logs, context, or audit payloads.
  // lgtm[js/insufficient-password-hash]
  return createHash('sha256').update(rawKey).digest('hex');
}

function isExpired(value: Date | string | null | undefined, now: number): boolean {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now;
}

async function bootstrapCredential(
  keyHash: string,
  trustedClientIp: string | undefined,
): Promise<CredentialBootstrap> {
  return withSystemDbAccessContext(async () => {
    const [credential] = await db
      .select({
        keyId: partnerServicePrincipalKeys.id,
        keyStatus: partnerServicePrincipalKeys.status,
        keyExpiresAt: partnerServicePrincipalKeys.expiresAt,
        rateLimit: partnerServicePrincipalKeys.rateLimit,
        partnerServicePrincipalId: partnerServicePrincipals.id,
        partnerId: partnerServicePrincipals.partnerId,
        name: partnerServicePrincipals.name,
        principalStatus: partnerServicePrincipals.status,
        principalExpiresAt: partnerServicePrincipals.expiresAt,
        scopes: partnerServicePrincipals.scopes,
        sourceCidrs: partnerServicePrincipals.sourceCidrs,
        partnerStatus: partners.status,
        partnerDeletedAt: partners.deletedAt,
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
      partnerServicePrincipalId: credential.partnerServicePrincipalId,
      keyId: credential.keyId,
      partnerId: credential.partnerId,
      name: credential.name,
      scopes: validatedScopes.scopes,
      rateLimit: credential.rateLimit,
    };
  });
}

function setRateLimitHeaders(
  c: Context,
  rateLimit: number,
  rateCheck: { remaining: number; resetAt: Date },
): void {
  c.header('X-RateLimit-Limit', String(rateLimit));
  c.header('X-RateLimit-Remaining', String(rateCheck.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(rateCheck.resetAt.getTime() / 1000)));
}

async function settleBookkeeping(
  work: () => void | Promise<void>,
  sanitizedFailureMessage: string,
): Promise<void> {
  try {
    await work();
  } catch {
    // Never include the caught error: database/audit errors can contain query
    // parameters or other sensitive context. Bookkeeping must also never
    // replace the downstream response or exception.
    console.error(sanitizedFailureMessage);
  }
}

async function recordMachineUse(
  c: Context,
  principal: PartnerApiPrincipalContext,
  result: 'success' | 'failure',
  status: number,
): Promise<void> {
  const work = [
    settleBookkeeping(
      () => runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          await db
            .update(partnerServicePrincipalKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(partnerServicePrincipalKeys.id, principal.keyId));
        }),
      ),
      'Failed to update partner API key usage timestamp',
    ),
  ];
  // The outer partner-export audit wrapper records the one canonical request
  // event after this middleware releases its RLS context. Preserve the legacy
  // machine-use event for standalone/direct middleware consumers only.
  if (!c.get('partnerExportAuditManaged')) work.push(
    settleBookkeeping(
      () => writeAuditEventAsync(c, {
        orgId: null,
        actorType: 'api_key',
        actorId: principal.keyId,
        action: 'partner_api.request',
        resourceType: 'partner_service_principal',
        resourceId: principal.partnerServicePrincipalId,
        result,
        details: {
          principalType: 'partner_service_principal',
          partnerId: principal.partnerId,
          keyId: principal.keyId,
          method: c.req.method.slice(0, 16),
          path: c.req.path.slice(0, 256),
          status,
        },
      }),
      'Failed to write partner API machine-use audit',
    ),
  );
  await Promise.all(work);
}

function downstreamStatus(c: Context, thrown: unknown): number {
  if (thrown) {
    return thrown instanceof HTTPException ? thrown.status : 500;
  }
  const responseStatus = c.res?.status;
  if (typeof responseStatus === 'number' && responseStatus >= 100) {
    return responseStatus;
  }
  return 200;
}

export async function partnerApiAuthMiddleware(c: Context, next: Next): Promise<void> {
  const rawKey = c.req.header('X-API-Key');
  if (!rawKey) {
    throw new HTTPException(401, { message: AUTH_REQUIRED_MESSAGE });
  }

  // Throttle before parsing/hashing/lookup so malformed probes cannot bypass
  // the same shared protection used by human-owned API keys.
  await enforcePreLookupProbeRateLimit(c);

  if (!PARTNER_API_KEY_PATTERN.test(rawKey)) {
    throw invalidCredentials();
  }

  const trustedClientIp = getTrustedClientIpOrUndefined(c);
  const bootstrap = await bootstrapCredential(hashPartnerApiKey(rawKey), trustedClientIp);

  // Expose only the already-authenticated IDs before rate limiting so the
  // outer audit wrapper can attribute a 429. No downstream handler runs until
  // organization discovery replaces this with the complete RLS principal.
  c.set('partnerApiPrincipal', { ...bootstrap, accessibleOrgIds: [] });

  // Redis work must happen after the short system transaction has closed.
  const rateCheck = await rateLimiter(
    getRedis(),
    `partner_api_rate:${bootstrap.partnerServicePrincipalId}:${bootstrap.keyId}`,
    bootstrap.rateLimit,
    3600,
  );
  setRateLimitHeaders(c, bootstrap.rateLimit, rateCheck);

  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.max(
      1,
      Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000),
    )));
    throw new HTTPException(429, { message: 'Partner API rate limit exceeded' });
  }

  // Credential identity is already validated. Keep it available for bounded
  // machine-use bookkeeping even if the lock-protected organization discovery
  // or RLS context switch itself fails before downstream routing begins.
  let principal: PartnerApiPrincipalContext = { ...bootstrap, accessibleOrgIds: [] };
  let downstreamError: unknown;
  try {
    await withResolvedDbAccessContext(async () => {
      // Hold partner discovery shared from allowlist discovery through the
      // route query. Organization visibility writers take the exclusive form,
      // so a newly-active org cannot be stamped before this request's
      // watermark yet remain absent from its discovered allowlist.
      await db.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${bootstrap.partnerId}::uuid]
      )`);
      const activeOrganizations = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(
          eq(organizations.partnerId, bootstrap.partnerId),
          eq(organizations.status, 'active'),
          isNull(organizations.deletedAt),
        ));
      const resolvedPrincipal: PartnerApiPrincipalContext = {
        ...bootstrap,
        accessibleOrgIds: activeOrganizations.map((organization) => organization.id),
      };
      return {
        context: {
          scope: 'partner' as const,
          orgId: null,
          accessibleOrgIds: resolvedPrincipal.accessibleOrgIds,
          accessiblePartnerIds: [bootstrap.partnerId],
          currentPartnerId: bootstrap.partnerId,
          userId: null,
        },
        value: resolvedPrincipal,
      };
    }, async (resolvedPrincipal) => {
      principal = resolvedPrincipal;
      c.set('partnerApiPrincipal', resolvedPrincipal);
      await next();
    });
  } catch (error) {
    downstreamError = error;
  }

  // Hono converts downstream throws handled by app.onError into c.error plus
  // c.res before upstream middleware resumes. Direct middleware invocations
  // can still reject, so account for both lifecycle shapes.
  const status = downstreamStatus(c, downstreamError);
  const result = downstreamError || c.error || status >= 400 ? 'failure' : 'success';

  // withDbAccessContext has fully resolved/rejected before bookkeeping starts.
  // Await both operations for deterministic completion while isolating their
  // failures from the downstream response/error.
  await recordMachineUse(c, principal, result, status);

  if (downstreamError) throw downstreamError;
}

export function requirePartnerApiScope(
  ...required: PartnerServicePrincipalScope[]
): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('partnerApiPrincipal');
    if (!principal) {
      throw new HTTPException(401, { message: AUTH_REQUIRED_MESSAGE });
    }

    if (!required.every((scope) => principal.scopes.includes(scope))) {
      throw new HTTPException(403, { message: 'Partner API scope required' });
    }

    await next();
  };
}
