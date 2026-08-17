import { Hono, type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { optionalQueryBoolean } from '@breeze/shared';

import { db } from '../db';
import {
  cisBaselines,
  cisBaselineResults,
  cisRemediationActions,
  devices,
  organizations,
} from '../db/schema';
import { scheduleCisRemediation, scheduleCisRemediationWithResult, scheduleCisScan } from '../jobs/cisJobs';
import { captureException } from '../services/sentry';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { canAccessSite, type UserPermissions } from '../services/permissions';
import { extractFailedCheckIds, normalizeCisSchedule } from '../services/cisHardening';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { resolveOrgId } from './networkShared';

export const cisHardeningRoutes = new Hono();

const osTypeSchema = z.enum(['windows', 'macos', 'linux']);
const baselineLevelSchema = z.enum(['l1', 'l2', 'custom']);

const listBaselinesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  osType: osTypeSchema.optional(),
  active: optionalQueryBoolean,
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const baselineScanScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(24 * 7).optional(),
  nextScanAt: z.string().datetime().nullable().optional(),
});

const upsertBaselineSchema = z.object({
  id: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  // Ownership axis (#2135, mirroring software policies #2126). 'organization'
  // (default) = classic org-scoped baseline. 'partner' = partner-wide /
  // all-orgs template; the server derives the partner from the caller's own
  // token — a client-supplied partner id is NEVER trusted. orgId is ignored
  // when ownerScope is 'partner'. Create-only: an existing baseline's owner
  // is immutable (see the update path).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().trim().min(1).max(200),
  osType: osTypeSchema,
  benchmarkVersion: z.string().trim().min(1).max(40),
  level: baselineLevelSchema,
  customExclusions: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  scanSchedule: baselineScanScheduleSchema.optional(),
  isActive: z.boolean().optional(),
});

const triggerScanSchema = z.object({
  orgId: z.string().guid().optional(),
  baselineId: z.string().guid(),
  deviceIds: z.array(z.string().guid()).max(500).optional(),
});

const complianceQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  baselineId: z.string().guid().optional(),
  osType: osTypeSchema.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const deviceReportQuerySchema = z.object({
  baselineId: z.string().guid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const remediateSchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid(),
  baselineId: z.string().guid().optional(),
  baselineResultId: z.string().guid().optional(),
  checkIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  action: z.enum(['apply', 'rollback']).default('apply'),
  reason: z.string().trim().max(1000).optional(),
});

const approveRemediationSchema = z.object({
  actionIds: z.array(z.string().guid()).min(1).max(500),
  approved: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Visibility filter for `cis_baselines` under dual ownership (#2135): the
 * caller's own org-axis rows, OR the partner-wide rows of their own partner.
 *
 * Unlike most partner-wide readers this is NOT gated on `auth.scope ===
 * 'partner'`. The table carries a SELECT-only
 * `cis_baselines_partner_wide_select` RLS policy keyed on
 * `breeze_current_partner_id()`, and that GUC is populated from the token's
 * partnerId for org-scoped sessions too (`buildDbAccessContext`) — so an org
 * user genuinely may read their partner's partner-wide baselines, and gating
 * this on partner scope would hide rows RLS is happy to return. It stays
 * read-only: `breeze_has_partner_access` is still false for an org token, so
 * every write path is unaffected.
 *
 * Returns undefined for system scope (no filter).
 */
function baselineVisibilityCondition(auth: AuthContext): SQL | undefined {
  const orgCondition = auth.orgCondition(cisBaselines.orgId);
  const partnerWide = auth.partnerId
    ? and(isNull(cisBaselines.orgId), eq(cisBaselines.partnerId, auth.partnerId))
    : undefined;

  // undefined orgCondition means UNRESTRICTED (system scope), not "match
  // nothing" — an empty accessible-org list yields an always-false SQL
  // instead. Narrowing to the partner branch here would silently hide every
  // org-owned baseline from system callers.
  if (!orgCondition) return undefined;
  return partnerWide ? or(orgCondition, partnerWide) : orgCondition;
}

async function resolveAuthorizedCisScanDeviceIds(
  auth: AuthContext,
  permissions: UserPermissions | undefined,
  baseline: typeof cisBaselines.$inferSelect,
  requestedDeviceIds: string[] | undefined,
): Promise<
  | { deviceIds: string[] }
  | { error: string; status: 400 | 403; deniedDeviceIds?: string[] }
> {
  const hasExplicitDeviceIds = Array.isArray(requestedDeviceIds) && requestedDeviceIds.length > 0;

  // Device eligibility follows the baseline's OWNER. `eq(devices.orgId,
  // baseline.orgId)` silently matches nothing when org_id is NULL, so a
  // partner-wide baseline resolves its devices through the org's partner
  // instead. Never widen past the caller's own org access, including when the
  // caller omits deviceIds and asks the server to resolve the full scope.
  const deviceOwnerCondition = baseline.partnerId
    ? inArray(
        devices.orgId,
        db.select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, baseline.partnerId))
      )
    : eq(devices.orgId, baseline.orgId!);
  const deviceOrgAccess = auth.orgCondition(devices.orgId);
  const conditions: SQL[] = [
    deviceOwnerCondition,
    ...(deviceOrgAccess ? [deviceOrgAccess] : []),
    eq(devices.osType, baseline.osType),
  ];

  if (hasExplicitDeviceIds) {
    conditions.push(inArray(devices.id, requestedDeviceIds));
  } else {
    // Mirror selectCisScanTargetDevices: server-resolved fan-out must never
    // include Quick Support machines or devices that have been decommissioned.
    conditions.push(eq(devices.isEphemeral, false), ne(devices.status, 'decommissioned'));
  }

  const rows = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(...conditions));

  if (hasExplicitDeviceIds && rows.length !== requestedDeviceIds.length) {
    return {
      error: 'One or more deviceIds do not belong to the baseline org/os scope',
      status: 400,
    };
  }

  // Site is an app-layer axis only: RLS cannot prevent a site-restricted user
  // from dispatching to another site within an otherwise authorized org.
  if (permissions?.allowedSiteIds) {
    const deniedDeviceIds = rows
      .filter((device) =>
        typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId)
      )
      .map((device) => device.id);

    if (hasExplicitDeviceIds && deniedDeviceIds.length > 0) {
      return {
        error: 'Access to one or more device sites denied',
        status: 403,
        deniedDeviceIds,
      };
    }

    if (!hasExplicitDeviceIds && deniedDeviceIds.length > 0) {
      const deniedDeviceIdSet = new Set(deniedDeviceIds);
      return {
        deviceIds: rows
          .filter((device) => !deniedDeviceIdSet.has(device.id))
          .map((device) => device.id),
      };
    }
  }

  return { deviceIds: rows.map((device) => device.id) };
}

function mapBaselineRow(row: typeof cisBaselines.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapResultRow(row: typeof cisBaselineResults.$inferSelect) {
  return {
    ...row,
    checkedAt: row.checkedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Sentinel returned when org-scope passes but the caller's site allowlist
 * excludes the device's site. Routes treat this as 403 (site denied),
 * distinct from `null` 404 (org-denied / missing) — mirrors the convention
 * in `routes/devices/helpers.ts` (`SITE_ACCESS_DENIED`).
 */
const CIS_SITE_DENIED = Symbol('CIS_SITE_DENIED');

/**
 * Per-device chokepoint for CIS hardening routes. Combines org-scope (via
 * `auth.orgCondition`) and site-scope (via `canAccessSite` on `c.get('permissions')`).
 *
 * Returns:
 *   - the device row when accessible
 *   - `null` when the device is missing OR caller's org-scope rejects it (→ 404)
 *   - `CIS_SITE_DENIED` when org passes but site allowlist excludes it (→ 403)
 *
 * Site is an app-layer concept only — Postgres RLS does not defend it, so
 * partner-scope users restricted to a subset of sites within an org would
 * otherwise be able to query/remediate devices outside their site allowlist.
 * See PR #864/#868 for the SP2 launch-readiness sweep this fix continues.
 */
async function assertDeviceAccess(c: Context, deviceId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      osType: devices.osType,
      hostname: devices.hostname,
      siteId: devices.siteId,
    })
    .from(devices)
    .where(and(...conditions))
    .limit(1);

  if (!device) return null;

  const permissions = c.get('permissions') as UserPermissions | undefined;
  if (permissions?.allowedSiteIds) {
    if (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId)) {
      return CIS_SITE_DENIED;
    }
  }

  return device;
}

cisHardeningRoutes.use('*', authMiddleware);

cisHardeningRoutes.get(
  '/baselines',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listBaselinesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      // An explicit orgId narrows to that org's own baselines PLUS the
      // partner-wide ones that apply to it — a partner-wide baseline governs
      // every org under the partner, so filtering it out here would make the
      // list disagree with what actually gets scanned.
      const partnerWide = auth.partnerId
        ? and(isNull(cisBaselines.orgId), eq(cisBaselines.partnerId, auth.partnerId))
        : undefined;
      const orgScoped = eq(cisBaselines.orgId, orgResult.orgId);
      conditions.push(partnerWide ? or(orgScoped, partnerWide)! : orgScoped);
    } else {
      const visibility = baselineVisibilityCondition(auth);
      if (visibility) conditions.push(visibility);
    }
    if (query.osType) conditions.push(eq(cisBaselines.osType, query.osType));
    if (typeof query.active === 'boolean') conditions.push(eq(cisBaselines.isActive, query.active));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cisBaselines)
      .where(where);

    const rows = await db
      .select()
      .from(cisBaselines)
      .where(where)
      .orderBy(desc(cisBaselines.updatedAt), desc(cisBaselines.id))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(mapBaselineRow),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0),
      },
    });
  }
);

cisHardeningRoutes.post(
  '/baselines',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', upsertBaselineSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    if (body.id) {
      // Look the row up by id ALONE and authorise from its own ownership axis.
      // The old (id, orgId) lookup cannot express partner ownership, and RLS
      // is not sufficient on its own here: the partner-wide SELECT branch lets
      // an ORG-scoped user READ their partner's rows, so a select-by-id can
      // legitimately return a row this caller must not write.
      const [existing] = await db
        .select()
        .from(cisBaselines)
        .where(eq(cisBaselines.id, body.id))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Baseline not found' }, 404);
      }

      if (existing.partnerId) {
        // Partner-wide row: only a full-partner admin of THAT partner may edit
        // it. canManagePartnerWidePolicies is false for org scope, which is
        // what stops the org-visible-but-not-writable case above.
        if (!canManagePartnerWidePolicies(auth) || auth.partnerId !== existing.partnerId) {
          return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
        }
      } else {
        const orgResult = resolveOrgId(auth, existing.orgId ?? undefined, true);
        if ('error' in orgResult) {
          return c.json({ error: orgResult.error }, orgResult.status);
        }
        if (!orgResult.orgId || orgResult.orgId !== existing.orgId) {
          return c.json({ error: 'Baseline not found for this organization' }, 404);
        }
      }

      const [updated] = await db
        .update(cisBaselines)
        .set({
          // Ownership is immutable: no orgId/partnerId in the SET. Moving a
          // baseline between owners would silently re-tenant every historical
          // result that references it.
          name: body.name,
          osType: body.osType,
          benchmarkVersion: body.benchmarkVersion,
          level: body.level,
          customExclusions: body.customExclusions ?? [],
          scanSchedule: normalizeCisSchedule(body.scanSchedule),
          isActive: body.isActive ?? existing.isActive,
          updatedAt: new Date(),
        })
        .where(eq(cisBaselines.id, existing.id))
        .returning();

      writeRouteAudit(c, {
        // null for a partner-wide row — writeRouteAudit maps null to undefined.
        // Do NOT substitute a fallback org; there isn't one.
        orgId: existing.orgId,
        action: 'cis.baseline.update',
        resourceType: 'cis_baseline',
        resourceId: existing.id,
        details: {
          name: body.name,
          osType: body.osType,
          level: body.level,
          ownerScope: existing.partnerId ? 'partner' : 'organization',
        },
      });

      return c.json({
        data: updated ? mapBaselineRow(updated) : null,
      });
    }

    // Create. Partner-wide baselines fan out to devices in EVERY org under the
    // partner (including orgs created later), so creation is gated on the
    // partner-wide capability. The partner is ALWAYS derived from the caller's
    // own token — a client-supplied partner id is never trusted.
    let owner: { orgId: string | null; partnerId: string | null };
    if (body.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide CIS baselines require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgResult = resolveOrgId(auth, body.orgId, true);
      if ('error' in orgResult) {
        return c.json({ error: orgResult.error }, orgResult.status);
      }
      if (!orgResult.orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }
      owner = { orgId: orgResult.orgId, partnerId: null };
    }

    const [created] = await db
      .insert(cisBaselines)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: body.name,
        osType: body.osType,
        benchmarkVersion: body.benchmarkVersion,
        level: body.level,
        customExclusions: body.customExclusions ?? [],
        scanSchedule: normalizeCisSchedule(body.scanSchedule),
        isActive: body.isActive ?? true,
        createdBy: auth.user.id,
        updatedAt: new Date(),
      })
      .returning();

    writeRouteAudit(c, {
      orgId: owner.orgId,
      action: 'cis.baseline.create',
      resourceType: 'cis_baseline',
      resourceId: created?.id,
      details: {
        name: body.name,
        osType: body.osType,
        level: body.level,
        ownerScope: body.ownerScope === 'partner' ? 'partner' : 'organization',
      },
    });

    return c.json({
      data: created ? mapBaselineRow(created) : null,
    }, 201);
  }
);

cisHardeningRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', triggerScanSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const conditions: SQL[] = [eq(cisBaselines.id, body.baselineId)];
    const visibility = baselineVisibilityCondition(auth);
    if (visibility) conditions.push(visibility);
    // body.orgId narrows an org-owned baseline; it must NOT exclude a
    // partner-wide one, which has no org_id and legitimately applies here.
    if (body.orgId) {
      conditions.push(or(eq(cisBaselines.orgId, body.orgId), isNull(cisBaselines.orgId))!);
    }

    const [baseline] = await db
      .select()
      .from(cisBaselines)
      .where(and(...conditions))
      .limit(1);

    if (!baseline) {
      return c.json({ error: 'Baseline not found or access denied' }, 404);
    }
    if (!baseline.isActive) {
      return c.json({ error: 'Baseline is inactive' }, 400);
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const resolved = await resolveAuthorizedCisScanDeviceIds(
      auth,
      permissions,
      baseline,
      body.deviceIds,
    );
    if ('error' in resolved) {
      return c.json({
        error: resolved.error,
        ...(resolved.deniedDeviceIds ? { deniedDeviceIds: resolved.deniedDeviceIds } : {}),
      }, resolved.status);
    }

    const resolvedDeviceIds = resolved.deviceIds;
    const jobId = resolvedDeviceIds.length > 0
      ? await scheduleCisScan(baseline.id, {
          requestedBy: auth.user.id,
          deviceIds: resolvedDeviceIds,
        })
      : null;

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'cis.scan.trigger',
      resourceType: 'cis_baseline',
      resourceId: baseline.id,
      details: {
        jobId,
        deviceCount: resolvedDeviceIds.length,
        requestedDeviceCount: body.deviceIds?.length ?? null,
      },
    });

    if (jobId === null) {
      return c.json({
        message: 'CIS scan queued',
        jobId: null,
        baselineId: baseline.id,
        deviceCount: 0,
      }, 202);
    }

    return c.json({
      message: 'CIS scan queued',
      jobId,
      baselineId: baseline.id,
    }, 202);
  }
);

cisHardeningRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', complianceQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisBaselineResults.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisBaselineResults.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.baselineId) conditions.push(eq(cisBaselineResults.baselineId, query.baselineId));
    if (query.osType) conditions.push(eq(cisBaselines.osType, query.osType));

    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      if (permissions.allowedSiteIds.length === 0) {
        return c.json({
          data: [],
          summary: {
            devicesAudited: 0,
            averageScore: 100,
            failingDevices: 0,
            compliantDevices: 0,
          },
          pagination: {
            limit: query.limit ?? 200,
            offset: query.offset ?? 0,
            total: 0,
          },
        });
      }
      conditions.push(inArray(devices.siteId, permissions.allowedSiteIds));
    }

    const rankedResults = db
      .select({
        resultId: cisBaselineResults.id,
        orgId: cisBaselineResults.orgId,
        deviceId: cisBaselineResults.deviceId,
        baselineId: cisBaselineResults.baselineId,
        checkedAt: cisBaselineResults.checkedAt,
        totalChecks: cisBaselineResults.totalChecks,
        passedChecks: cisBaselineResults.passedChecks,
        failedChecks: cisBaselineResults.failedChecks,
        score: cisBaselineResults.score,
        findings: cisBaselineResults.findings,
        summary: cisBaselineResults.summary,
        resultCreatedAt: sql<Date>`${cisBaselineResults.createdAt}`.as('result_created_at'),
        baselineName: cisBaselines.name,
        baselineOsType: sql<string>`${cisBaselines.osType}`.as('baseline_os_type'),
        baselineBenchmarkVersion: cisBaselines.benchmarkVersion,
        baselineLevel: cisBaselines.level,
        baselineCustomExclusions: cisBaselines.customExclusions,
        baselineScanSchedule: cisBaselines.scanSchedule,
        baselineIsActive: cisBaselines.isActive,
        baselineCreatedAt: sql<Date>`${cisBaselines.createdAt}`.as('baseline_created_at'),
        baselineUpdatedAt: cisBaselines.updatedAt,
        deviceHostname: devices.hostname,
        deviceStatus: devices.status,
        deviceOsType: sql<string>`${devices.osType}`.as('device_os_type'),
        rn: sql<number>`row_number() over (partition by ${cisBaselineResults.deviceId}, ${cisBaselineResults.baselineId} order by ${cisBaselineResults.checkedAt} desc)`.as('rn'),
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .innerJoin(devices, eq(cisBaselineResults.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .as('ranked_cis_results');

    const latestConditions: SQL[] = [eq(rankedResults.rn, 1)];
    if (typeof query.minScore === 'number') {
      latestConditions.push(gte(rankedResults.score, query.minScore));
    }
    if (typeof query.maxScore === 'number') {
      latestConditions.push(lte(rankedResults.score, query.maxScore));
    }

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const [summaryRow] = await db
      .select({
        total: sql<number>`count(*)`,
        averageScore: sql<number>`coalesce(round(avg(${rankedResults.score})), 100)`,
        failingDevices: sql<number>`coalesce(sum(case when ${rankedResults.failedChecks} > 0 then 1 else 0 end), 0)`,
      })
      .from(rankedResults)
      .where(and(...latestConditions));

    const rows = await db
      .select({
        resultId: rankedResults.resultId,
        orgId: rankedResults.orgId,
        deviceId: rankedResults.deviceId,
        baselineId: rankedResults.baselineId,
        checkedAt: rankedResults.checkedAt,
        totalChecks: rankedResults.totalChecks,
        passedChecks: rankedResults.passedChecks,
        failedChecks: rankedResults.failedChecks,
        score: rankedResults.score,
        findings: rankedResults.findings,
        summary: rankedResults.summary,
        resultCreatedAt: rankedResults.resultCreatedAt,
        baselineName: rankedResults.baselineName,
        baselineOsType: rankedResults.baselineOsType,
        baselineBenchmarkVersion: rankedResults.baselineBenchmarkVersion,
        baselineLevel: rankedResults.baselineLevel,
        baselineCustomExclusions: rankedResults.baselineCustomExclusions,
        baselineScanSchedule: rankedResults.baselineScanSchedule,
        baselineIsActive: rankedResults.baselineIsActive,
        baselineCreatedAt: rankedResults.baselineCreatedAt,
        baselineUpdatedAt: rankedResults.baselineUpdatedAt,
        deviceHostname: rankedResults.deviceHostname,
        deviceStatus: rankedResults.deviceStatus,
        deviceOsType: rankedResults.deviceOsType,
      })
      .from(rankedResults)
      .where(and(...latestConditions))
      .orderBy(desc(rankedResults.checkedAt), desc(rankedResults.resultId))
      .limit(limit)
      .offset(offset);

    const total = Number(summaryRow?.total ?? 0);
    const averageScore = Number(summaryRow?.averageScore ?? 100);
    const failingDevices = Number(summaryRow?.failingDevices ?? 0);

    const toISO = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : String(v ?? '');

    return c.json({
      data: rows.map((row) => ({
        result: {
          id: row.resultId,
          orgId: row.orgId,
          deviceId: row.deviceId,
          baselineId: row.baselineId,
          checkedAt: toISO(row.checkedAt),
          totalChecks: row.totalChecks,
          passedChecks: row.passedChecks,
          failedChecks: row.failedChecks,
          score: row.score,
          findings: row.findings ?? [],
          summary: row.summary ?? {},
          createdAt: toISO(row.resultCreatedAt),
        },
        baseline: {
          id: row.baselineId,
          orgId: row.orgId,
          name: row.baselineName,
          osType: row.baselineOsType,
          benchmarkVersion: row.baselineBenchmarkVersion,
          level: row.baselineLevel,
          customExclusions: row.baselineCustomExclusions ?? [],
          scanSchedule: row.baselineScanSchedule,
          isActive: row.baselineIsActive,
          createdAt: toISO(row.baselineCreatedAt),
          updatedAt: toISO(row.baselineUpdatedAt),
        },
        device: {
          id: row.deviceId,
          hostname: row.deviceHostname,
          osType: row.deviceOsType,
          status: row.deviceStatus,
        },
      })),
      summary: {
        devicesAudited: total,
        averageScore,
        failingDevices,
        compliantDevices: Math.max(0, total - failingDevices),
      },
      pagination: {
        limit,
        offset,
        total,
      },
    });
  }
);

cisHardeningRoutes.get(
  '/devices/:deviceId/report',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', deviceReportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const query = c.req.valid('query');

    const device = await assertDeviceAccess(c, deviceId, auth);
    if (device === CIS_SITE_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const conditions: SQL[] = [
      eq(cisBaselineResults.deviceId, device.id),
      eq(cisBaselineResults.orgId, device.orgId),
    ];
    if (query.baselineId) conditions.push(eq(cisBaselineResults.baselineId, query.baselineId));

    const rows = await db
      .select({
        result: cisBaselineResults,
        baseline: cisBaselines,
      })
      .from(cisBaselineResults)
      .innerJoin(cisBaselines, eq(cisBaselineResults.baselineId, cisBaselines.id))
      .where(and(...conditions))
      .orderBy(desc(cisBaselineResults.checkedAt))
      .limit(query.limit ?? 50);

    return c.json({
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
      },
      reports: rows.map((row) => ({
        result: mapResultRow(row.result),
        baseline: mapBaselineRow(row.baseline),
      })),
    });
  }
);

cisHardeningRoutes.post(
  '/remediate',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', remediateSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const requestedCheckIds = Array.from(new Set(body.checkIds));

    const device = await assertDeviceAccess(c, body.deviceId, auth);
    if (device === CIS_SITE_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }
    if (body.orgId && body.orgId !== device.orgId) {
      return c.json({ error: 'orgId does not match device organization' }, 400);
    }

    let baselineResultId = body.baselineResultId ?? null;
    let baselineId = body.baselineId ?? null;
    let baselineFindings: unknown = [];

    if (baselineResultId) {
      const [result] = await db
        .select({
          id: cisBaselineResults.id,
          baselineId: cisBaselineResults.baselineId,
          orgId: cisBaselineResults.orgId,
          findings: cisBaselineResults.findings,
        })
        .from(cisBaselineResults)
        .where(and(
          eq(cisBaselineResults.id, baselineResultId),
          eq(cisBaselineResults.deviceId, device.id),
          eq(cisBaselineResults.orgId, device.orgId),
        ))
        .limit(1);

      if (!result) {
        return c.json({ error: 'baselineResultId does not match the selected device/org' }, 400);
      }
      baselineId = result.baselineId;
      baselineFindings = result.findings;
    } else {
      const conditions: SQL[] = [
        eq(cisBaselineResults.deviceId, device.id),
        eq(cisBaselineResults.orgId, device.orgId),
      ];
      if (baselineId) conditions.push(eq(cisBaselineResults.baselineId, baselineId));

      const [latest] = await db
        .select({
          id: cisBaselineResults.id,
          baselineId: cisBaselineResults.baselineId,
          findings: cisBaselineResults.findings,
        })
        .from(cisBaselineResults)
        .where(and(...conditions))
        .orderBy(desc(cisBaselineResults.checkedAt))
        .limit(1);

      if (!latest) {
        return c.json({ error: 'No CIS baseline result found for this device' }, 404);
      }
      baselineResultId = latest.id;
      baselineId = latest.baselineId;
      baselineFindings = latest.findings;
    }

    const failedCheckIds = extractFailedCheckIds(baselineFindings);
    if (failedCheckIds.size === 0) {
      return c.json({ error: 'Selected baseline result has no failed checks to remediate' }, 400);
    }

    const [baseline] = await db
      .select({
        id: cisBaselines.id,
        orgId: cisBaselines.orgId,
        partnerId: cisBaselines.partnerId,
        osType: cisBaselines.osType,
      })
      .from(cisBaselines)
      .where(eq(cisBaselines.id, baselineId!))
      .limit(1);

    // Compatibility follows the baseline's OWNER: an org-owned baseline must
    // match the device's org; a partner-wide one governs every org under its
    // partner. `baseline.orgId !== device.orgId` alone rejects every
    // partner-wide baseline, since its org_id is NULL.
    const [deviceOrg] = baseline?.partnerId
      ? await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, device.orgId))
          .limit(1)
      : [undefined];
    const ownerMatches = !!baseline && (baseline.partnerId
      ? deviceOrg?.partnerId === baseline.partnerId
      : baseline.orgId === device.orgId);

    if (!baseline || !ownerMatches || baseline.osType !== device.osType) {
      return c.json({ error: 'Baseline is not compatible with the selected device' }, 400);
    }

    const invalidCheckIds = requestedCheckIds.filter((checkId) => !failedCheckIds.has(checkId));
    if (invalidCheckIds.length > 0) {
      return c.json({
        error: 'One or more checkIds are not currently failing for the selected baseline result',
        invalidCheckIds,
      }, 400);
    }

    const remediationRows: Array<typeof cisRemediationActions.$inferInsert> = requestedCheckIds.map((checkId) => ({
      orgId: device.orgId,
      deviceId: device.id,
      baselineId,
      baselineResultId,
      checkId,
      action: body.action,
      status: 'pending_approval',
      approvalStatus: 'pending',
      requestedBy: auth.user.id,
      details: {
        source: 'api',
        reason: body.reason ?? null,
        requestedAt: new Date().toISOString(),
      },
    }));

    const inserted = await db
      .insert(cisRemediationActions)
      .values(remediationRows)
      .returning({ id: cisRemediationActions.id, checkId: cisRemediationActions.checkId });

    const actionIds = inserted.map((row) => row.id);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'cis.remediation.request',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        baselineId,
        baselineResultId,
        requested: inserted.length,
        checkIds: inserted.map((row) => row.checkId),
      },
    });

    return c.json({
      message: `Created ${inserted.length} CIS remediation action(s) pending approval`,
      deviceId: device.id,
      baselineId,
      baselineResultId,
      actionIds,
      approvalStatus: 'pending',
    }, 201);
  }
);

cisHardeningRoutes.post(
  '/remediate/approve',
  requireScope('organization', 'partner', 'system'),
  requirePermission('orgs', 'write'),
  zValidator('json', approveRemediationSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const conditions: SQL[] = [inArray(cisRemediationActions.id, body.actionIds)];
    const orgCondition = auth.orgCondition(cisRemediationActions.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const actions = await db
      .select({
        id: cisRemediationActions.id,
        orgId: cisRemediationActions.orgId,
        deviceId: cisRemediationActions.deviceId,
        status: cisRemediationActions.status,
        approvalStatus: cisRemediationActions.approvalStatus,
        requestedBy: cisRemediationActions.requestedBy,
      })
      .from(cisRemediationActions)
      .where(and(...conditions));

    const foundIds = new Set(actions.map((row) => row.id));
    const missingIds = body.actionIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return c.json({
        error: 'One or more remediation actions were not found or are outside your scope',
        missingIds,
      }, 404);
    }

    // Site-scope re-check: RLS only defends the org axis. A
    // site-restricted user could otherwise approve/queue pending actions another
    // tech created for devices outside their site allowlist, dispatching CIS
    // hardening/rollback commands to endpoints beyond their authority. Mirror the
    // `assertDeviceAccess` / `POST /cis/remediate` site check on each action's
    // target device before any status flip. Empty/unset allowlist = full org access.
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      const targetDeviceIds = Array.from(new Set(actions.map((action) => action.deviceId)));
      const deviceRows = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(inArray(devices.id, targetDeviceIds));
      const deviceSiteById = new Map(deviceRows.map((row) => [row.id, row.siteId]));

      const deniedActionIds = actions
        .filter((action) => {
          const siteId = deviceSiteById.get(action.deviceId);
          return typeof siteId !== 'string' || !canAccessSite(permissions, siteId);
        })
        .map((action) => action.id);

      if (deniedActionIds.length > 0) {
        return c.json({
          error: 'One or more remediation actions target a device outside your site scope',
          deniedActionIds,
        }, 403);
      }
    }

    const pendingIds = actions
      .filter((action) => action.status === 'pending_approval' && action.approvalStatus === 'pending')
      .map((action) => action.id);
    const skippedIds = actions
      .filter((action) => !(action.status === 'pending_approval' && action.approvalStatus === 'pending'))
      .map((action) => action.id);

    if (pendingIds.length === 0) {
      return c.json({
        error: 'No pending remediation actions eligible for approval update',
        skippedIds,
      }, 400);
    }

    // Maker/checker: the requester cannot approve their own pending actions.
    // CIS remediation queues hardening/rollback commands to endpoints, so the
    // pending_approval → approved transition is a separation-of-duties control.
    // Mirror the auditBaselines apply-approval guard. (Denials are skipped on
    // an approval; an explicit rejection by the requester is still allowed.)
    if (body.approved) {
      const selfApprovedIds = actions
        .filter((action) => pendingIds.includes(action.id) && action.requestedBy === auth.user.id)
        .map((action) => action.id);
      if (selfApprovedIds.length > 0) {
        return c.json({
          error: 'Requester cannot approve their own remediation actions',
          selfApprovedIds,
        }, 403);
      }
    }

    const now = new Date();
    if (body.approved) {
      await db
        .update(cisRemediationActions)
        .set({
          status: 'queued',
          approvalStatus: 'approved',
          approvedBy: auth.user.id,
          approvedAt: now,
          approvalNote: body.note ?? null,
        })
        .where(inArray(cisRemediationActions.id, pendingIds));

      let queueResult;
      try {
        queueResult = await scheduleCisRemediationWithResult(pendingIds);
      } catch (error) {
        captureException(error);
        // Rollback approval status on total queue failure
        await db
          .update(cisRemediationActions)
          .set({
            status: 'pending_approval',
            approvalStatus: 'pending',
            approvedBy: null,
            approvedAt: null,
            approvalNote: null,
          })
          .where(inArray(cisRemediationActions.id, pendingIds));
        return c.json({ error: 'Failed to queue remediation actions, approval rolled back' }, 500);
      }

      // Mark any individually failed actions back to pending
      if (queueResult.failedActionIds.length > 0) {
        await db
          .update(cisRemediationActions)
          .set({
            status: 'pending_approval',
            approvalStatus: 'pending',
            approvedBy: null,
            approvedAt: null,
            approvalNote: null,
          })
          .where(inArray(cisRemediationActions.id, queueResult.failedActionIds));
      }

      const queued = queueResult.queuedActionIds.length;
      const orgIds = Array.from(new Set(actions.map((action) => action.orgId)));
      for (const orgId of orgIds) {
        writeRouteAudit(c, {
          orgId,
          action: 'cis.remediation.approve',
          resourceType: 'cis_remediation_action',
          details: {
            approved: true,
            queued,
            actionIds: pendingIds,
            skippedIds,
            failedActionIds: queueResult.failedActionIds,
          },
        });
      }

      return c.json({
        approved: true,
        queued,
        actionIds: queueResult.queuedActionIds,
        skippedIds,
        failedActionIds: queueResult.failedActionIds.length > 0 ? queueResult.failedActionIds : undefined,
      });
    }

    await db
      .update(cisRemediationActions)
      .set({
        status: 'cancelled',
        approvalStatus: 'rejected',
        approvedBy: auth.user.id,
        approvedAt: now,
        approvalNote: body.note ?? null,
      })
      .where(inArray(cisRemediationActions.id, pendingIds));

    const orgIds = Array.from(new Set(actions.map((action) => action.orgId)));
    for (const orgId of orgIds) {
      writeRouteAudit(c, {
        orgId,
        action: 'cis.remediation.approve',
        resourceType: 'cis_remediation_action',
        details: {
          approved: false,
          actionIds: pendingIds,
          skippedIds,
        },
      });
    }

    return c.json({
      approved: false,
      rejected: pendingIds.length,
      actionIds: pendingIds,
      skippedIds,
    });
  }
);

const listRemediationsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: z.enum(['pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  deviceId: z.string().guid().optional(),
  baselineId: z.string().guid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

cisHardeningRoutes.get(
  '/remediations',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listRemediationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisRemediationActions.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisRemediationActions.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.status) conditions.push(eq(cisRemediationActions.status, query.status));
    if (query.approvalStatus) conditions.push(eq(cisRemediationActions.approvalStatus, query.approvalStatus));
    if (query.deviceId) conditions.push(eq(cisRemediationActions.deviceId, query.deviceId));
    if (query.baselineId) conditions.push(eq(cisRemediationActions.baselineId, query.baselineId));

    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      if (query.deviceId) {
        const device = await assertDeviceAccess(c, query.deviceId, auth);
        if (!device || device === CIS_SITE_DENIED) {
          return c.json({ error: 'Device not found or access denied' }, 403);
        }
      }
      if (permissions.allowedSiteIds.length === 0) {
        return c.json({
          data: [],
          pagination: {
            limit: query.limit ?? 100,
            offset: query.offset ?? 0,
            total: 0,
          },
        });
      }
      conditions.push(inArray(devices.siteId, permissions.allowedSiteIds));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cisRemediationActions)
      .innerJoin(devices, eq(cisRemediationActions.deviceId, devices.id))
      .where(where);

    const rows = await db
      .select({
        action: cisRemediationActions,
        deviceHostname: devices.hostname,
        baselineName: cisBaselines.name,
      })
      .from(cisRemediationActions)
      .innerJoin(devices, eq(cisRemediationActions.deviceId, devices.id))
      .leftJoin(cisBaselines, eq(cisRemediationActions.baselineId, cisBaselines.id))
      .where(where)
      .orderBy(desc(cisRemediationActions.createdAt), desc(cisRemediationActions.id))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map((row) => ({
        ...row.action,
        createdAt: row.action.createdAt.toISOString(),
        executedAt: row.action.executedAt?.toISOString() ?? null,
        approvedAt: row.action.approvedAt?.toISOString() ?? null,
        deviceHostname: row.deviceHostname,
        baselineName: row.baselineName,
      })),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0),
      },
    });
  }
);
