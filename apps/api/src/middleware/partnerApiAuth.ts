import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { markPermissionGate } from './permissionGate';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { UNASSIGNED_POOL_ORG_TYPE } from '../services/unassignedPool/orgType';
import {
  db,
  runOutsideDbContext,
  withResolvedDbAccessContext,
  withSystemDbAccessContext,
} from '../db';
import {
  organizations,
  partnerServicePrincipalKeys,
} from '../db/schema';
import { getRedis, rateLimiter } from '../services';
import { writeAuditEventAsync } from '../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import {
  hashPartnerApiKey,
  isPartnerServicePrincipalKeyFormat,
  loadPartnerServicePrincipalCredential,
} from '../services/partnerServicePrincipalCredential';
import type { PartnerServicePrincipalScope } from '../services/partnerServicePrincipalScopes';
import { enforcePreLookupProbeRateLimit } from './apiKeyAuth';

export interface PartnerApiPrincipalContext {
  partnerServicePrincipalId: string;
  keyId: string;
  partnerId: string;
  name: string;
  scopes: PartnerServicePrincipalScope[];
  accessibleOrgIds: string[];
  rateLimit: number;
  principalExpiresAt?: Date | string | null;
  sourceCidrs?: string[];
}

declare module 'hono' {
  interface ContextVariableMap {
    partnerApiPrincipal: PartnerApiPrincipalContext;
  }
}

type CredentialBootstrap = Omit<PartnerApiPrincipalContext, 'accessibleOrgIds'>;

const AUTH_REQUIRED_MESSAGE = 'Partner API authentication required';
const INVALID_CREDENTIALS_MESSAGE = 'Invalid partner API credentials';

/**
 * Ceiling for non-GET requests, counted per principal+key per hour in a
 * bucket separate from (and always at most equal to) the key's own limit.
 * Provisioning writes are low-volume by nature — an onboarding run creating
 * an org, a handful of sites, and per-site enrollment keys for 80 customers
 * fits comfortably — while an unattended credential minting organizations at
 * read-export speed is a billing/abuse signal, not a workload (#3243).
 */
export const PARTNER_API_WRITE_RATE_LIMIT_PER_HOUR = 120;

/**
 * Ticket writes are a workload, not a provisioning event: a PSA/ITSM mirror
 * posts a comment or status change per technician action across every
 * customer, so they get their own hourly bucket with a higher default
 * (`PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR`), still capped by the
 * key's own limit. Provisioning writes keep the 120/hour bucket untouched —
 * ticket volume can never spend the provisioning budget, nor vice versa.
 */
export const PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR_DEFAULT = 1200;
/**
 * Second ceiling, partner-wide. A partner admin can create service
 * principals, so a per-principal bucket alone is multiplied by however many
 * they mint; the partner bucket is what that number cannot be multiplied
 * past (same two-bucket shape as enrollment-key minting). Charged after the
 * per-principal bucket, and never lower than it.
 */
export const PARTNER_API_TICKET_WRITE_PARTNER_RATE_LIMIT_PER_HOUR_DEFAULT = 6000;
const TICKET_WRITE_PATH = /(?:^|\/partner-api)\/tickets(?:\/|$)/u;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type PartnerApiWriteLimit =
  | { bucket: 'default'; limit: number }
  | { bucket: 'tickets'; limit: number; partnerLimit: number };

/** The write bucket(s) and ceiling(s) for a non-GET request, by path family. */
export function partnerApiWriteLimitFor(path: string, keyLimit: number): PartnerApiWriteLimit {
  if (TICKET_WRITE_PATH.test(path)) {
    const limit = Math.min(keyLimit, positiveEnvInt('PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR', PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR_DEFAULT));
    const partnerLimit = Math.max(limit, positiveEnvInt('PARTNER_API_TICKET_WRITE_PARTNER_RATE_LIMIT_PER_HOUR', PARTNER_API_TICKET_WRITE_PARTNER_RATE_LIMIT_PER_HOUR_DEFAULT));
    return { bucket: 'tickets', limit, partnerLimit };
  }
  return { bucket: 'default', limit: Math.min(keyLimit, PARTNER_API_WRITE_RATE_LIMIT_PER_HOUR) };
}

function invalidCredentials(): HTTPException {
  return new HTTPException(401, { message: INVALID_CREDENTIALS_MESSAGE });
}

async function bootstrapCredential(
  keyHash: string,
  trustedClientIp: string | undefined,
): Promise<CredentialBootstrap> {
  // Shared with the MCP endpoint (middleware/partnerServicePrincipalMcpAuth.ts)
  // so both surfaces enforce one credential lifecycle.
  return (await loadPartnerServicePrincipalCredential(keyHash, trustedClientIp)).credential;
}

// The hidden per-partner 'quick_support' org is an internal Quick Support
// artifact, never a customer tenant — it must not enter the Partner API's
// accessible set (which every export route derives its org filter from,
// including the caller-supplied ?orgId, validated against this list).
// Verified: the Partner API mounts no support-session routes, so removing
// it here costs no functionality.
async function discoverAccessibleOrgIds(partnerId: string): Promise<string[]> {
  const activeOrganizations = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      eq(organizations.status, 'active'),
      isNull(organizations.deletedAt),
      ne(organizations.type, 'quick_support'),
      // Holding org is never human-reachable.
      ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
    ));
  return activeOrganizations.map((organization) => organization.id);
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

  if (!isPartnerServicePrincipalKeyFormat(rawKey)) {
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

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    // Non-GET (#3243): provisioning writes run OUTSIDE the read path's held
    // partner-RLS snapshot transaction, for two reasons:
    //
    // 1. The held read transaction takes the partner discovery advisory lock
    //    SHARED for the whole request, while an `organizations` INSERT fires
    //    a statement trigger that must take the same lock EXCLUSIVE
    //    (2026-07-21-partner-export-canonical-org-mutations.sql). Running
    //    that insert from a nested system transaction on a second pooled
    //    connection would wait on our own request's shared lock — an
    //    application-level self-deadlock that only a statement timeout ends.
    //
    // 2. Writes take no export snapshot, so the consistency machinery the
    //    lock exists for does not apply. This mirrors the human /orgs/*
    //    write routes, which also run their inserts in bounded contexts.
    //
    // Handlers therefore receive NO ambient DB context and must open their
    // own bounded withDbAccessContext / withSystemDbAccessContext per
    // operation (the contextless-write guard enforces this).
    const writeFamily = partnerApiWriteLimitFor(c.req.path, bootstrap.rateLimit);
    let writeLimit = writeFamily.limit;
    let writeCheck = await rateLimiter(
      getRedis(),
      writeFamily.bucket === 'default'
        ? `partner_api_write_rate:${bootstrap.partnerServicePrincipalId}:${bootstrap.keyId}`
        : `partner_api_write_rate:${writeFamily.bucket}:${bootstrap.partnerServicePrincipalId}:${bootstrap.keyId}`,
      writeLimit,
      3600,
    );
    // Two buckets, both charged, narrowest first: the partner-wide ceiling is
    // only consulted (and only spent) once the per-principal bucket admits
    // the request, so a principal that is already over budget cannot drain
    // its siblings' shared allowance.
    if (writeCheck.allowed && writeFamily.bucket === 'tickets') {
      const partnerCheck = await rateLimiter(
        getRedis(),
        `partner_api_write_rate:${writeFamily.bucket}:partner:${bootstrap.partnerId}`,
        writeFamily.partnerLimit,
        3600,
      );
      if (!partnerCheck.allowed) {
        writeLimit = writeFamily.partnerLimit;
        writeCheck = partnerCheck;
      }
    }
    setRateLimitHeaders(c, writeLimit, writeCheck);
    if (!writeCheck.allowed) {
      c.header('Retry-After', String(Math.max(
        1,
        Math.ceil((writeCheck.resetAt.getTime() - Date.now()) / 1000),
      )));
      throw new HTTPException(429, { message: 'Partner API rate limit exceeded' });
    }

    try {
      const accessibleOrgIds = await withSystemDbAccessContext(() =>
        discoverAccessibleOrgIds(bootstrap.partnerId),
      );
      principal = { ...bootstrap, accessibleOrgIds };
      c.set('partnerApiPrincipal', principal);
      await next();
    } catch (error) {
      downstreamError = error;
    }

    const writeStatus = downstreamStatus(c, downstreamError);
    const writeResult = downstreamError || c.error || writeStatus >= 400 ? 'failure' : 'success';
    await recordMachineUse(c, principal, writeResult, writeStatus);
    if (downstreamError) throw downstreamError;
    return;
  }

  try {
    await withResolvedDbAccessContext(async () => {
      // Hold partner discovery shared from allowlist discovery through the
      // route query. Organization visibility writers take the exclusive form,
      // so a newly-active org cannot be stamped before this request's
      // watermark yet remain absent from its discovered allowlist.
      await db.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${bootstrap.partnerId}::uuid]
      )`);
      const resolvedPrincipal: PartnerApiPrincipalContext = {
        ...bootstrap,
        accessibleOrgIds: await discoverAccessibleOrgIds(bootstrap.partnerId),
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
  return markPermissionGate(async (c, next) => {
    const principal = c.get('partnerApiPrincipal');
    if (!principal) {
      throw new HTTPException(401, { message: AUTH_REQUIRED_MESSAGE });
    }

    if (!required.every((scope) => principal.scopes.includes(scope))) {
      throw new HTTPException(403, { message: 'Partner API scope required' });
    }

    await next();
  }, `partner-api:${required.join('+')}`);
}
