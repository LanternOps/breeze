/**
 * Partner API provisioning writes (#3243).
 *
 * The three create routes that let a partner service principal provision
 * tenancy unattended: organizations, sites, enrollment keys. Decisions from
 * the #3243 thread this file implements:
 *
 * - Writes live on the Partner API because the machine principal already
 *   authenticates here; the human `/orgs/*` MFA gate is never involved and
 *   `hasSatisfiedMfa` is untouched.
 * - Create only. Deletion of tenancy stays human + MFA on the main API.
 * - `partnerId` always comes from the principal — a body-supplied value is
 *   stripped by the schemas, never honored.
 * - Every route is listed in the `writeSurface.test.ts` allowlist; responses
 *   reuse the read-side export DTO contracts so `exportSafety` applies to
 *   created objects exactly as it does to reads.
 *
 * Execution model: the auth middleware gives non-GET requests NO ambient DB
 * context (see partnerApiAuth.ts) — each handler opens its own bounded
 * context per operation, mirroring the human write routes.
 */
import { Hono } from 'hono';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isValidIanaTimezone } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { createHash } from 'node:crypto';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  enrollmentKeys,
  organizations,
  partnerEnrollmentKeyIdempotency,
  partners,
  sites,
} from '../../db/schema';
// Concrete module, not the barrel — see the note in routes/orgs.ts.
import { ORG_SLUG_UNIQUE_INDEX } from '../../db/schema/orgs';
// The canonical SQLSTATE helpers — see their JSDoc for why a hand-rolled
// top-level `err.code === '23505'` check is dead for every Drizzle-issued
// statement. Related sightings of that bug class: #3998, #4020, #4245.
import { isPgUniqueViolation, pgErrorNode } from '../../utils/pgErrors';
import {
  requirePartnerApiScope,
  type PartnerApiPrincipalContext,
} from '../../middleware/partnerApiAuth';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { assertTtlWithinCap } from '../../services/enrollmentDefaults';
import { syncSiteContactRow } from '../../services/contacts/compat';
import {
  generateEnrollmentKey,
  getDefaultEnrollmentKeyTtlMinutes,
  hashEnrollmentKey,
  hashEnrollmentSecret,
} from '../../services/enrollmentKeySecurity';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { computePartnerExportRevision, safelyExportDefinition } from './exportSafety';
import { jsonField } from './organizations';
import {
  enrollmentKeyCreateResponseSchema,
  enrollmentKeyReplayResponseSchema,
  organizationCreateResponseSchema,
  siteCreateResponseSchema,
  type PartnerExportResource,
} from './schemas';

// Same 365-day ceiling as the human enrollment-key routes (enrollmentKeys.ts
// MAX_TTL_MINUTES / devices/core.ts ENROLL_TOKEN_MAX_TTL_MINUTES).
const ENROLLMENT_KEY_MAX_TTL_MINUTES = 525_600;

// Credential minting gets its own fail-closed bucket. The generic per-principal
// Partner API budget is shared with read/export traffic and is far too generous
// for an endpoint that mints device-join credentials.
const ENROLLMENT_KEY_MINT_WINDOW_SECONDS = 60 * 60;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  // Reject NaN, non-positive values, and trailing garbage (e.g. "7d", "0", "-1").
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

// `partnerId` is intentionally absent from every body schema: the principal's
// partner always wins, and zod strips unrecognized keys on non-strict objects,
// so a caller-supplied `partnerId` is silently ignored rather than trusted.
const createOrganizationBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100),
  type: z.enum(['customer', 'internal']).optional(),
  // Narrower than the human create schema on purpose: an unattended
  // provisioning credential creating `suspended`/`churned` tenants is not a
  // workload. Lifecycle transitions stay on the human API.
  status: z.enum(['active', 'trial']).optional(),
});

const boundedAddressString = z.string().max(1000).nullable().optional();
// Mirrors the read DTO's normalized shape (partnerSiteAddressSchema /
// partnerSiteContactSchema) so what a principal writes is exactly what it
// reads back. Free-form `settings` is deliberately NOT writable here — it is
// an open container the read DTO never exposes.
const createSiteBodySchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  timezone: z.string().max(64).refine(isValidIanaTimezone, 'Invalid IANA timezone').default('UTC'),
  address: z.object({
    line1: boundedAddressString,
    line2: boundedAddressString,
    city: boundedAddressString,
    region: boundedAddressString,
    postalCode: boundedAddressString,
    country: boundedAddressString,
  }).strict().nullable().optional(),
  contact: z.object({
    name: boundedAddressString,
    email: boundedAddressString,
    phone: boundedAddressString,
  }).strict().nullable().optional(),
});

// Mirrors createEnrollmentKeySchema on the human route: `.strict()`,
// `ttlMinutes` XOR `expiresAt`, `maxUsage` 1–100000. `orgId` is required —
// a machine caller always knows its target org (unlike the human route's
// single-org partner convenience default).
const createEnrollmentKeyBodySchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  maxUsage: z.number().int().min(1).max(100000).optional(),
  expiresAt: z.string().datetime().optional(),
  ttlMinutes: z.number().int().min(1).max(ENROLLMENT_KEY_MAX_TTL_MINUTES).optional(),
}).strict().refine(
  (data) => !(data.expiresAt !== undefined && data.ttlMinutes !== undefined),
  { message: 'Pass either ttlMinutes or expiresAt, not both', path: ['ttlMinutes'] },
);

function partnerScopedDbContext(principal: PartnerApiPrincipalContext): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: principal.accessibleOrgIds,
    accessiblePartnerIds: [principal.partnerId],
    currentPartnerId: principal.partnerId,
    userId: null,
  };
}

/** Thrown inside the create-organization transaction to roll back an insert
 *  that a concurrent create pushed past `partner.maxOrganizations`. */
class OrgQuotaExceededError extends Error {
  constructor(readonly cap: number) {
    super('partner organization quota exceeded');
    this.name = 'OrgQuotaExceededError';
  }
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function auditProvisioningCreate(
  c: Parameters<typeof writeAuditEventAsync>[0],
  principal: PartnerApiPrincipalContext,
  event: {
    orgId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    resourceName: string;
    details?: Record<string, unknown>;
  },
): void {
  // Attribution is the SERVICE PRINCIPAL (actorType api_key / key id), never a
  // human — there is no user anywhere in this auth path (userId is null).
  void writeAuditEventAsync(c, {
    orgId: event.orgId,
    actorType: 'api_key',
    actorId: principal.keyId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    resourceName: event.resourceName,
    result: 'success',
    details: {
      principalType: 'partner_service_principal',
      partnerServicePrincipalId: principal.partnerServicePrincipalId,
      keyId: principal.keyId,
      partnerId: principal.partnerId,
      ...event.details,
    },
  });
}

function createdResponse(
  resource: PartnerExportResource,
  identity: { id: string; orgId: string },
  record: Record<string, unknown>,
) {
  const definition = { ...record, revision: computePartnerExportRevision(record) };
  const inspected = safelyExportDefinition({ resource, ...identity }, definition);
  return inspected.safe
    ? { data: inspected.definition, blocked: undefined }
    : { data: null, blocked: [inspected.blocked] };
}

export const partnerProvisioningRoutes = new Hono();

partnerProvisioningRoutes.post(
  '/organizations',
  requirePartnerApiScope('organizations:write'),
  zValidator('json', createOrganizationBodySchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const data = c.req.valid('json');

    type CreateOutcome =
      | { kind: 'created'; organization: typeof organizations.$inferSelect; sourceUpdatedAt: Date }
      | { kind: 'quota'; cap: number }
      | { kind: 'failed' };

    async function countPartnerOrganizations(partnerId: string): Promise<number> {
      const [tally] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(organizations)
        .where(and(
          eq(organizations.partnerId, partnerId),
          isNull(organizations.deletedAt),
          ne(organizations.type, 'quick_support'),
        ));
      return tally?.value ?? 0;
    }

    let outcome: CreateOutcome;
    try {
      // System context (bounded to this operation): a freshly created org's id
      // cannot be in any accessible_org_ids pre-insert, so the id-keyed RLS
      // policies on `organizations` reject both the INSERT and its RETURNING
      // under partner scope — same escape the human route uses. Partner
      // authority was established by the auth middleware.
      outcome = await withSystemDbAccessContext(async (): Promise<CreateOutcome> => {
        const [partnerRow] = await db
          .select({
            maxOrganizations: partners.maxOrganizations,
            currencyCode: partners.currencyCode,
          })
          .from(partners)
          .where(eq(partners.id, principal.partnerId))
          .limit(1);
        if (!partnerRow) return { kind: 'failed' };
        const cap = partnerRow.maxOrganizations;
        // Fast path: refuse before inserting. This check alone is racy — two
        // concurrent creates could both pass it — so it is backed by the
        // post-insert recount below.
        if (cap !== null && await countPartnerOrganizations(principal.partnerId) >= cap) {
          return { kind: 'quota', cap };
        }

        const [organization] = await db
          .insert(organizations)
          .values({
            partnerId: principal.partnerId,
            currencyCode: partnerRow.currencyCode,
            name: data.name,
            slug: data.slug,
            type: data.type,
            status: data.status,
          })
          .returning();
        if (!organization) return { kind: 'failed' };

        // Race-free quota enforcement WITHOUT calling the partner-export lock
        // functions (EXECUTE is deliberately revoked from breeze_app — they
        // are private to the SECURITY DEFINER insert triggers, see
        // 2026-07-22-partner-export-lock-upgrade-hardening.sql). The insert
        // statement's own AFTER trigger takes the partner discovery lock
        // EXCLUSIVE, so concurrent same-partner org inserts serialize on it
        // until COMMIT: by the time a second transaction's insert returns,
        // the first one's row is committed and visible to this READ COMMITTED
        // recount. Over the cap → throw, which rolls the whole transaction
        // (and our insert) back.
        if (cap !== null && await countPartnerOrganizations(principal.partnerId) > cap) {
          throw new OrgQuotaExceededError(cap);
        }

        // The AFTER-statement export trigger has already stamped
        // partner_export_updated_at by now; re-read it so the create response
        // carries the same sourceUpdatedAt/revision a subsequent GET returns.
        const [stamped] = await db
          .select({ partnerExportUpdatedAt: organizations.partnerExportUpdatedAt })
          .from(organizations)
          .where(eq(organizations.id, organization.id))
          .limit(1);
        return {
          kind: 'created',
          organization,
          sourceUpdatedAt: stamped?.partnerExportUpdatedAt ?? organization.updatedAt,
        };
      });
    } catch (error) {
      if (error instanceof OrgQuotaExceededError) {
        // The transaction (including the over-cap insert) has rolled back.
        outcome = { kind: 'quota', cap: error.cap };
      } else if (isPgUniqueViolation(error, ORG_SLUG_UNIQUE_INDEX)) {
        // #3982 — pinned to the slug index BY NAME, not to "some 23505".
        // Before #3967 there was no unique index on (partner_id, lower(slug)),
        // so an unconstrained check was dead for slugs and nothing exercised
        // how wrong it was; #3967 made it live.
        //
        // The slug index is not the only unique index this INSERT is subject
        // to: `organizations` also carries organizations_id_partner_id_unique
        // on (id, partner_id) — practically unreachable today, since `id`
        // defaults to a random UUID — and the set of indexes on this table is
        // not fixed. (The AFTER triggers are NOT a source: the only one that
        // writes another table inserts into partner_export_configuration_org_state
        // with ON CONFLICT DO NOTHING, so it cannot raise 23505.) The argument
        // for naming the index is therefore about construction, not about a
        // failure that is imminent: a check that answers
        // `partner_provisioning_slug_conflict` for a constraint it never
        // verified tells an unattended provisioning client — confidently — to
        // go fix a slug that was never the problem, which is worse than no
        // diagnosis because it sends the retry loop somewhere it can never
        // succeed. Anything that is not this index falls through to the
        // generic error path and surfaces as a 500: the honest answer for a
        // unique violation this route does not model.
        return c.json({
          error: 'An organization with this slug already exists.',
          code: 'partner_provisioning_slug_conflict',
        }, 409);
      } else {
        // A 23505 that is NOT the slug index lands here. `app.onError` does log
        // it and capture it to Sentry, so it is not silent — but it captures the
        // `DrizzleQueryError`, whose SQLSTATE and constraint sit on `.cause`,
        // leaving triage to unwrap them by hand. Name the constraint once, here,
        // at the only point that still knows this was a unique violation the
        // route deliberately declined to call a slug conflict. Warn-level, not
        // error: onError owns the error-level report.
        const pgNode = pgErrorNode(error);
        if (pgNode?.code === '23505') {
          const constraint = pgNode.constraint_name ?? pgNode.constraint;
          console.warn(
            '[partner-provisioning] organization create raised an unmodelled unique violation ' +
            `(constraint=${typeof constraint === 'string' ? constraint : 'unknown'}); ` +
            'answering 500, NOT partner_provisioning_slug_conflict',
          );
        }
        throw error;
      }
    }

    if (outcome.kind === 'quota') {
      // Deliberately specific (not a generic 500): an unattended credential
      // hitting the org cap is a billing conversation, not a server fault.
      return c.json({
        error: `Organization limit reached (${outcome.cap}). Contact your Breeze administrator to raise the partner cap.`,
        code: 'partner_provisioning_org_limit_reached',
      }, 409);
    }
    if (outcome.kind === 'failed') {
      return c.json({ error: 'Organization create failed.', code: 'partner_provisioning_failed' }, 500);
    }

    const { organization, sourceUpdatedAt } = outcome;
    auditProvisioningCreate(c, principal, {
      orgId: organization.id,
      action: 'organization.create',
      resourceType: 'organization',
      resourceId: organization.id,
      resourceName: organization.name,
      details: { status: organization.status, type: organization.type },
    });

    const body = createdResponse('organizations', { id: organization.id, orgId: organization.id }, {
      id: organization.id,
      orgId: organization.id,
      siteId: null,
      sourceUpdatedAt: iso(sourceUpdatedAt),
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
    });
    return c.json(organizationCreateResponseSchema.parse({
      schemaVersion: '1' as const,
      data: body.data,
      ...(body.blocked ? { blocked: body.blocked } : {}),
    }), 201);
  },
);

partnerProvisioningRoutes.post(
  '/sites',
  requirePartnerApiScope('sites:write'),
  zValidator('json', createSiteBodySchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const data = c.req.valid('json');

    if (!principal.accessibleOrgIds.includes(data.orgId)) {
      return c.json({
        error: 'Access to this organization denied.',
        code: 'partner_provisioning_org_access_denied',
      }, 403);
    }

    const created = await withDbAccessContext(partnerScopedDbContext(principal), async () => {
      const [site] = await db
        .insert(sites)
        .values({
          orgId: data.orgId,
          name: data.name,
          timezone: data.timezone,
          address: data.address ?? null,
          contact: data.contact ?? null,
        })
        .returning();
      if (!site) return null;
      // Mirror into `contacts` inside the same partner-scoped context as the
      // insert — `contacts` is policed by breeze_has_org_access(org_id), the
      // same predicate the `sites` insert above just satisfied. actorId is null
      // because a partner API principal is an API key, not a user.
      if (data.contact) {
        await syncSiteContactRow(db, site.orgId, site.id, data.contact, null);
      }
      const [stamped] = await db
        .select({ partnerExportUpdatedAt: sites.partnerExportUpdatedAt })
        .from(sites)
        .where(eq(sites.id, site.id))
        .limit(1);
      return { site, sourceUpdatedAt: stamped?.partnerExportUpdatedAt ?? site.updatedAt };
    });
    if (!created) {
      return c.json({ error: 'Site create failed.', code: 'partner_provisioning_failed' }, 500);
    }

    const { site, sourceUpdatedAt } = created;
    auditProvisioningCreate(c, principal, {
      orgId: site.orgId,
      action: 'site.create',
      resourceType: 'site',
      resourceId: site.id,
      resourceName: site.name,
    });

    const body = createdResponse('sites', { id: site.id, orgId: site.orgId }, {
      id: site.id,
      orgId: site.orgId,
      siteId: site.id,
      sourceUpdatedAt: iso(sourceUpdatedAt),
      name: site.name,
      timezone: site.timezone,
      address: site.address ? {
        line1: jsonField(site.address, ['line1', 'addressLine1', 'street1']),
        line2: jsonField(site.address, ['line2', 'addressLine2', 'street2']),
        city: jsonField(site.address, ['city']),
        region: jsonField(site.address, ['region', 'state']),
        postalCode: jsonField(site.address, ['postalCode', 'zip']),
        country: jsonField(site.address, ['country']),
      } : null,
      contact: site.contact ? {
        name: jsonField(site.contact, ['name']),
        email: jsonField(site.contact, ['email']),
        phone: jsonField(site.contact, ['phone']),
      } : null,
    });
    return c.json(siteCreateResponseSchema.parse({
      schemaVersion: '1' as const,
      data: body.data,
      ...(body.blocked ? { blocked: body.blocked } : {}),
    }), 201);
  },
);

partnerProvisioningRoutes.post(
  '/enrollment-keys',
  requirePartnerApiScope('enrollment-keys:write'),
  zValidator('json', createEnrollmentKeyBodySchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const data = c.req.valid('json');

    const idempotencyHeader = c.req.header('X-Idempotency-Key');
    // Validate before any Redis or database I/O. The value is persisted in a
    // bounded varchar and participates in a unique index.
    if (idempotencyHeader !== undefined && (
      idempotencyHeader.length === 0
      || idempotencyHeader.length > 128
      || !/^[\x20-\x7E]+$/.test(idempotencyHeader)
    )) {
      return c.json({
        error: 'X-Idempotency-Key must be 1-128 printable ASCII characters.',
        code: 'partner_provisioning_invalid_idempotency_key',
      }, 400);
    }

    // SECURITY: the human MFA boundary for this capability is the scope grant
    // itself. Because the mint is machine-to-machine, every minting principal
    // must additionally be time-bounded and network-bounded. A SQL cross-column
    // CHECK enforces the same invariant below the API layer.
    if (!principal.principalExpiresAt || (principal.sourceCidrs?.length ?? 0) === 0) {
      return c.json({
        error: 'enrollment-keys:write requires a principal expiry and a source CIDR allowlist.',
        code: 'partner_provisioning_principal_restrictions_required',
      }, 403);
    }

    if (!principal.accessibleOrgIds.includes(data.orgId)) {
      return c.json({
        error: 'Access to this organization denied.',
        code: 'partner_provisioning_org_access_denied',
      }, 403);
    }

    // Reject (never clamp) a TTL above the partner cap — both expiry paths,
    // same as the human route (#2776): capping only ttlMinutes would leave
    // expiresAt as a wide-open bypass. assertTtlWithinCap manages its own
    // system-context read, so it runs before any bounded context opens.
    const impliedTtlMinutes = data.ttlMinutes !== undefined
      ? data.ttlMinutes
      : data.expiresAt !== undefined
        ? Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 60_000)
        : undefined;
    const capError = await assertTtlWithinCap(data.orgId, impliedTtlMinutes);
    if (capError) {
      return c.json({ error: capError, code: 'partner_provisioning_ttl_exceeds_cap' }, 400);
    }

    // Fail closed: the shared limiter rejects when Redis is unavailable rather
    // than allowing an unmetered mint. Runs outside any bounded DB context so
    // the Redis round-trip never happens on a pinned RLS connection.
    const mintRate = await runOutsideDbContext(() => rateLimiter(
      getRedis(),
      `rl:partner-enrollment-key-mint:${principal.partnerServicePrincipalId}`,
      envInt('PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT', 10),
      ENROLLMENT_KEY_MINT_WINDOW_SECONDS,
    ));
    if (!mintRate.allowed) {
      c.header('Retry-After', String(Math.max(
        1,
        Math.ceil((mintRate.resetAt.getTime() - Date.now()) / 1000),
      )));
      return c.json({
        error: 'Enrollment key mint rate limit exceeded.',
        code: 'partner_provisioning_rate_limited',
      }, 429);
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const rawEnrollmentSecret = generateEnrollmentKey();
    // Two different hashers on purpose, and they are not interchangeable.
    // `key` is peppered; `key_secret_hash` is plain SHA-256 because the agent
    // enrollment path (routes/agents/enrollment.ts) compares it against
    // hashEnrollmentSecret(), which must also match the on-the-fly hash of a
    // globally configured AGENT_ENROLLMENT_SECRET. Peppering this column makes
    // every minted secret fail enrollment with 403.
    const keySecretHash = hashEnrollmentSecret(rawEnrollmentSecret);
    const expiresAt = data.ttlMinutes !== undefined
      ? new Date(Date.now() + data.ttlMinutes * 60 * 1000)
      : data.expiresAt
        ? new Date(data.expiresAt)
        : new Date(Date.now() + getDefaultEnrollmentKeyTtlMinutes() * 60 * 1000);

    // Fingerprint follows the key insertion order Zod produces, which is the
    // declaration order of createEnrollmentKeyBodySchema. Stable today, but
    // reordering that schema's fields would change every fingerprint and make
    // in-flight retries look like body mismatches for one retention window.
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');

    const outcome = await withDbAccessContext(partnerScopedDbContext(principal), async () => {
      // Durable replay lookup precedes mutable site validation, so a completed
      // retry stays stable even if the site is deleted after the first call.
      if (idempotencyHeader) {
        const [claim] = await db
          .select()
          .from(partnerEnrollmentKeyIdempotency)
          .where(and(
            eq(
              partnerEnrollmentKeyIdempotency.partnerServicePrincipalId,
              principal.partnerServicePrincipalId,
            ),
            eq(partnerEnrollmentKeyIdempotency.idempotencyKey, idempotencyHeader),
          ))
          .limit(1);
        if (claim) {
          if (claim.requestFingerprint !== requestFingerprint) {
            return { kind: 'idempotency_mismatch' as const };
          }
          if (!claim.enrollmentKeyId) return { kind: 'idempotency_unavailable' as const };
          const [existing] = await db
            .select()
            .from(enrollmentKeys)
            .where(eq(enrollmentKeys.id, claim.enrollmentKeyId))
            .limit(1);
          if (!existing) return { kind: 'idempotency_unavailable' as const };
          return { kind: 'replay' as const, enrollmentKey: existing };
        }
      }

      if (data.siteId) {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, data.siteId), eq(sites.orgId, data.orgId)))
          .limit(1);
        if (!site) return { kind: 'bad_site' as const };
      }
      const insertValues = {
        orgId: data.orgId,
        siteId: data.siteId ?? null,
        name: data.name,
        key: keyHash,
        keySecretHash,
        maxUsage: data.maxUsage ?? 1,
        expiresAt,
        // No human in this auth path; attribution lives in the audit event.
        createdBy: null,
      };

      if (!idempotencyHeader) {
        const [enrollmentKey] = await db.insert(enrollmentKeys).values(insertValues).returning();
        return enrollmentKey
          ? { kind: 'created' as const, enrollmentKey }
          : { kind: 'failed' as const };
      }

      // The claim, the key insert, and the claim-to-key link commit together.
      // Without that, PostgreSQL could commit a live credential whose one-time
      // plaintext is then lost because the claim never recorded it.
      return db.transaction(async (tx) => {
        const [claim] = await tx
          .insert(partnerEnrollmentKeyIdempotency)
          .values({
            partnerId: principal.partnerId,
            partnerServicePrincipalId: principal.partnerServicePrincipalId,
            orgId: data.orgId,
            idempotencyKey: idempotencyHeader,
            requestFingerprint,
          })
          .onConflictDoNothing()
          .returning();
        // Lost the race on the unique index: the winner is committing, so this
        // request must not mint a second key.
        if (!claim) return { kind: 'idempotency_raced' as const };

        const [enrollmentKey] = await tx.insert(enrollmentKeys).values(insertValues).returning();
        if (!enrollmentKey) return { kind: 'failed' as const };

        const [linked] = await tx
          .update(partnerEnrollmentKeyIdempotency)
          .set({ enrollmentKeyId: enrollmentKey.id })
          .where(eq(partnerEnrollmentKeyIdempotency.id, claim.id))
          .returning();
        if (!linked) throw new Error('idempotency claim link failed');

        return { kind: 'created' as const, enrollmentKey };
      });
    });

    if (outcome.kind === 'bad_site') {
      return c.json({
        error: 'siteId does not belong to the specified org.',
        code: 'partner_provisioning_site_mismatch',
      }, 400);
    }
    if (outcome.kind === 'failed') {
      return c.json({ error: 'Enrollment key create failed.', code: 'partner_provisioning_failed' }, 500);
    }
    if (outcome.kind === 'idempotency_mismatch') {
      return c.json({
        error: 'X-Idempotency-Key was already used with a different request body.',
        code: 'partner_provisioning_idempotency_key_reused',
      }, 409);
    }
    if (outcome.kind === 'idempotency_raced') {
      return c.json({
        error: 'A concurrent request with this X-Idempotency-Key is in flight. Retry.',
        code: 'partner_provisioning_idempotency_in_flight',
      }, 409);
    }
    if (outcome.kind === 'idempotency_unavailable') {
      return c.json({
        error: 'Idempotency result unavailable.',
        code: 'partner_provisioning_idempotency_state_invalid',
      }, 503);
    }
    if (outcome.kind === 'replay') {
      // Metadata only: the raw key and enrollment secret were returned once, to
      // the request that committed them, and are unrecoverable by design.
      const replayed = outcome.enrollmentKey;
      return c.json(enrollmentKeyReplayResponseSchema.parse({
        schemaVersion: '1' as const,
        data: {
          id: replayed.id,
          orgId: replayed.orgId,
          siteId: replayed.siteId,
          name: replayed.name,
          usageCount: replayed.usageCount,
          maxUsage: replayed.maxUsage,
          expiresAt: replayed.expiresAt ? iso(replayed.expiresAt) : null,
          createdAt: iso(replayed.createdAt),
        },
        idempotencyReplay: true as const,
      }), 200);
    }

    const { enrollmentKey } = outcome;
    auditProvisioningCreate(c, principal, {
      orgId: enrollmentKey.orgId,
      action: 'enrollment_key.create',
      resourceType: 'enrollment_key',
      resourceId: enrollmentKey.id,
      resourceName: enrollmentKey.name,
      details: {
        siteId: enrollmentKey.siteId,
        maxUsage: enrollmentKey.maxUsage,
        expiresAt: enrollmentKey.expiresAt,
      },
    });

    // The raw key is returned exactly once, deliberately OUTSIDE `data`: the
    // DTO record is a strict no-secret allowlist and the response schema pins
    // the one-time credential to a single explicit top-level field.
    return c.json(enrollmentKeyCreateResponseSchema.parse({
      schemaVersion: '1' as const,
      data: {
        id: enrollmentKey.id,
        orgId: enrollmentKey.orgId,
        siteId: enrollmentKey.siteId,
        name: enrollmentKey.name,
        usageCount: enrollmentKey.usageCount,
        maxUsage: enrollmentKey.maxUsage,
        expiresAt: enrollmentKey.expiresAt ? iso(enrollmentKey.expiresAt) : null,
        createdAt: iso(enrollmentKey.createdAt),
      },
      key: rawKey,
      enrollmentSecret: rawEnrollmentSecret,
    }), 201);
  },
);
