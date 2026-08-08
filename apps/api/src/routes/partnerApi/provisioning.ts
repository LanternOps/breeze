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
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { enrollmentKeys, organizations, partners, sites } from '../../db/schema';
import {
  requirePartnerApiScope,
  type PartnerApiPrincipalContext,
} from '../../middleware/partnerApiAuth';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { assertTtlWithinCap } from '../../services/enrollmentDefaults';
import {
  generateEnrollmentKey,
  getDefaultEnrollmentKeyTtlMinutes,
  hashEnrollmentKey,
} from '../../services/enrollmentKeySecurity';
import { computePartnerExportRevision, safelyExportDefinition } from './exportSafety';
import { jsonField } from './organizations';
import {
  enrollmentKeyCreateResponseSchema,
  organizationCreateResponseSchema,
  siteCreateResponseSchema,
  type PartnerExportResource,
} from './schemas';

// Same 365-day ceiling as the human enrollment-key routes (enrollmentKeys.ts
// MAX_TTL_MINUTES / devices/core.ts ENROLL_TOKEN_MAX_TTL_MINUTES).
const ENROLLMENT_KEY_MAX_TTL_MINUTES = 525_600;

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

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (error as { cause?: unknown }).cause;
  return !!cause && typeof cause === 'object' && (cause as { code?: unknown }).code === '23505';
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
  c: Parameters<typeof writeAuditEventAsync>[0] & { json: Function },
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

    let outcome: CreateOutcome;
    try {
      // System context (bounded to this operation): a freshly created org's id
      // cannot be in any accessible_org_ids pre-insert, so the id-keyed RLS
      // policies on `organizations` reject both the INSERT and its RETURNING
      // under partner scope — same escape the human route uses. Partner
      // authority was established by the auth middleware.
      outcome = await withSystemDbAccessContext(async (): Promise<CreateOutcome> => {
        // Take the partner-export discovery lock EXCLUSIVE up front. This (a)
        // serializes concurrent creates for the same partner so the
        // maxOrganizations check below cannot be raced past the cap, and (b)
        // pre-empts the `organizations` insert trigger, which takes the same
        // lock and treats an already-held exclusive as re-entrant.
        await db.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
          ARRAY[${principal.partnerId}::uuid]
        )`);

        const [partnerRow] = await db
          .select({ maxOrganizations: partners.maxOrganizations })
          .from(partners)
          .where(eq(partners.id, principal.partnerId))
          .limit(1);
        const cap = partnerRow?.maxOrganizations ?? null;
        if (cap !== null) {
          const [tally] = await db
            .select({ value: sql<number>`count(*)::int` })
            .from(organizations)
            .where(and(
              eq(organizations.partnerId, principal.partnerId),
              isNull(organizations.deletedAt),
              ne(organizations.type, 'quick_support'),
            ));
          if ((tally?.value ?? 0) >= cap) return { kind: 'quota', cap };
        }

        const [organization] = await db
          .insert(organizations)
          .values({
            partnerId: principal.partnerId,
            name: data.name,
            slug: data.slug,
            type: data.type,
            status: data.status,
          })
          .returning();
        if (!organization) return { kind: 'failed' };

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
      if (isUniqueViolation(error)) {
        return c.json({
          error: 'An organization with this slug already exists.',
          code: 'partner_provisioning_slug_conflict',
        }, 409);
      }
      throw error;
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

    const body = createdResponse(c, 'organizations', { id: organization.id, orgId: organization.id }, {
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

    const body = createdResponse(c, 'sites', { id: site.id, orgId: site.orgId }, {
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

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = data.ttlMinutes !== undefined
      ? new Date(Date.now() + data.ttlMinutes * 60 * 1000)
      : data.expiresAt
        ? new Date(data.expiresAt)
        : new Date(Date.now() + getDefaultEnrollmentKeyTtlMinutes() * 60 * 1000);

    const outcome = await withDbAccessContext(partnerScopedDbContext(principal), async () => {
      if (data.siteId) {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, data.siteId), eq(sites.orgId, data.orgId)))
          .limit(1);
        if (!site) return { kind: 'bad_site' as const };
      }
      const [enrollmentKey] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: data.orgId,
          siteId: data.siteId ?? null,
          name: data.name,
          key: keyHash,
          maxUsage: data.maxUsage ?? 1,
          expiresAt,
          // No human in this auth path; attribution lives in the audit event.
          createdBy: null,
        })
        .returning();
      return enrollmentKey
        ? { kind: 'created' as const, enrollmentKey }
        : { kind: 'failed' as const };
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
    }), 201);
  },
);
