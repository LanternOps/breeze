import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { loadAndResolveEffectivePeripheralPolicySet } from '../services/peripheralEffectivePolicy';
import {
  organizations,
  peripheralDeviceClassEnum,
  peripheralEventTypeEnum,
  peripheralEvents,
  peripheralPolicies,
  peripheralPolicyActionEnum,
  peripheralPolicyTargetTypeEnum,
  devices,
  deviceGroups,
  type PeripheralExceptionRule,
  type PeripheralPolicyTargetIds
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';
import { canMutateOrgWideGovernance, hasSiteCeiling, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';
import {
  resolvePeripheralPolicyDeviceIds,
  schedulePeripheralPolicyDevices,
} from '../jobs/peripheralJobs';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { publishEvent } from '../services/eventBus';

import { notHoldingOrgCondition } from '../services/unassignedPool/selectorPredicate';
export const peripheralControlRoutes = new Hono();
const MAX_ACTIVITY_WINDOW_DAYS = 90;

peripheralControlRoutes.use('*', authMiddleware);
peripheralControlRoutes.use('*', requireScope('organization', 'partner', 'system'));

const policySchema = z.object({
  id: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  // 'partner' creates a partner-wide ("all orgs") policy: orgId NULL,
  // partnerId = caller's partner (#2131). Honored on CREATE only — this
  // schema doubles as the update body (id set), and updates never move a
  // policy between ownership axes.
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(200),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues),
  action: z.enum(peripheralPolicyActionEnum.enumValues),
  // No schema defaults on targeting: this schema doubles as the update body, and
  // an update that omits targetType/targetIds keeps the stored targeting (#9620).
  // The create path applies the 'organization' / {} defaults itself.
  targetType: z.enum(peripheralPolicyTargetTypeEnum.enumValues).optional(),
  priority: z.number().int().safe().min(0).max(1000).optional(),
  targetIds: z.object({
    siteIds: z.array(z.string().guid()).max(1000).optional(),
    groupIds: z.array(z.string().guid()).max(1000).optional(),
    deviceIds: z.array(z.string().guid()).max(5000).optional(),
  }).optional(),
  exceptions: z.array(z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
    allow: z.boolean().optional(),
    reason: z.string().min(1).max(2000).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  })).max(2000).optional(),
  isActive: z.boolean().optional(),
});

const listPoliciesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  action: z.enum(peripheralPolicyActionEnum.enumValues).optional(),
  deviceClass: z.enum(peripheralDeviceClassEnum.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const listActivityQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  policyId: z.string().guid().optional(),
  eventType: z.enum(peripheralEventTypeEnum.enumValues).optional(),
  peripheralType: z.string().min(1).max(40).optional(),
  vendor: z.string().min(1).max(255).optional(),
  product: z.string().min(1).max(255).optional(),
  serialNumber: z.string().min(1).max(255).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const disablePolicyParamSchema = z.object({
  id: z.string().guid(),
});

const exceptionsSchema = z.object({
  policyId: z.string().guid(),
  operation: z.enum(['add', 'remove']),
  exception: z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
    allow: z.boolean().optional(),
    reason: z.string().min(1).max(2000).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  }).optional(),
  match: z.object({
    vendor: z.string().min(1).max(255).optional(),
    product: z.string().min(1).max(255).optional(),
    serialNumber: z.string().min(1).max(255).optional(),
  }).superRefine((value, ctx) => {
    if (!value.vendor && !value.product && !value.serialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of vendor, product, or serialNumber is required',
      });
    }
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.operation === 'add' && !value.exception) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exception is required for add operation',
      path: ['exception'],
    });
  }

  if (value.operation === 'remove' && !value.match) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'match is required for remove operation',
      path: ['match'],
    });
  }
});

function resolveOrgIdForWrite(
  auth: AuthContext,
  requestedOrgId?: string
): { orgId?: string; error?: string; status?: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Cannot write outside your organization', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  // Any caller with several accessible orgs that omits orgId lands here (#8338), so name the field.
  return { error: 'orgId is required: send the owning organization as orgId in the request body', status: 400 };
}

// Resolve the device IDs a site-restricted caller may read within their org,
// narrowed by `permissions.allowedSiteIds`. Returns null when the caller has no
// site restriction (no narrowing needed). Site is an app-layer concept only —
// Postgres RLS does NOT defend it — so a site-restricted org user must not read
// peripheral/USB events for devices in other sites within the same org.
// `allowedSiteIds` is only ever set for org-scope users (see permissions.ts), so
// `orgId` is guaranteed present whenever narrowing applies. Mirrors browserSecurity.ts.
async function resolveSiteAllowedDeviceIds(
  orgId: string,
  perms: UserPermissions | undefined,
): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId))
    .map((d) => d.id);
}

function combineWarning(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function normalizeExceptionRule(rule: z.infer<typeof exceptionsSchema>['exception']): PeripheralExceptionRule | null {
  if (!rule) return null;
  return {
    vendor: rule.vendor?.trim() || undefined,
    product: rule.product?.trim() || undefined,
    serialNumber: rule.serialNumber?.trim() || undefined,
    allow: rule.allow ?? true,
    reason: rule.reason?.trim() || undefined,
    expiresAt: rule.expiresAt
  };
}

type PeripheralPolicyTargetType = (typeof peripheralPolicyTargetTypeEnum.enumValues)[number];

function sanitizeTargetIds(targetIds: z.infer<typeof policySchema>['targetIds']): PeripheralPolicyTargetIds {
  if (!targetIds) return {};
  return {
    siteIds: targetIds.siteIds ?? [],
    groupIds: targetIds.groupIds ?? [],
    deviceIds: targetIds.deviceIds ?? [],
  };
}

/**
 * Targeting for an update (#9620). Omitting both fields keeps the stored
 * targeting — the web form cannot edit targets, and must not widen a
 * site/group/device policy to the whole org on save. targetIds omitted with
 * the same targetType keeps the stored ids; switching targetType without
 * naming new ids clears them rather than reinterpreting the old ones.
 */
function resolveUpdateTargeting(
  payload: Pick<z.infer<typeof policySchema>, 'targetType' | 'targetIds'>,
  existing: { targetType: PeripheralPolicyTargetType; targetIds: PeripheralPolicyTargetIds | null }
): { targetType: PeripheralPolicyTargetType; targetIds: PeripheralPolicyTargetIds } {
  const targetType = payload.targetType ?? existing.targetType;
  if (payload.targetIds !== undefined) {
    return { targetType, targetIds: sanitizeTargetIds(payload.targetIds) };
  }
  if (targetType === existing.targetType) {
    return { targetType, targetIds: existing.targetIds ?? {} };
  }
  return { targetType, targetIds: sanitizeTargetIds({}) };
}

// Dual-axis access condition (#2131): org-owned rows the caller can reach OR
// partner-wide rows (org_id NULL) owned by the caller's own partner. Gated on
// partner scope — org tokens carry a partnerId but never pass
// breeze_has_partner_access, so RLS is stricter than this app condition.
function peripheralPolicyAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(peripheralPolicies.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${peripheralPolicies.orgId} IS NULL AND ${peripheralPolicies.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/** The caller's site ceiling, or undefined when they are not site-restricted. */
function readerSiteCeiling(auth: AuthContext): string[] | undefined {
  return hasSiteCeiling(auth) ? auth.allowedSiteIds : undefined;
}

/**
 * For a site-restricted reader: only policies that reach at least one of
 * their sites — an org-wide policy, or a site/group/device-targeted policy
 * whose targets include something in their sites. `jsonb_exists*` (the `?` /
 * `?|` operators) is false rather than an error on a missing key.
 */
function peripheralPolicySiteVisibilityCondition(allowedSiteIds: string[], orgId: string | null): SQL {
  const siteArray = allowedSiteIds.length > 0
    ? sql`ARRAY[${sql.join(allowedSiteIds.map((id) => sql`${id}`), sql`, `)}]::text[]`
    : sql`ARRAY[]::text[]`;
  const deviceOrg = orgId ? sql` AND ${eq(devices.orgId, orgId)}` : sql``;
  const groupOrg = orgId ? sql` AND ${eq(deviceGroups.orgId, orgId)}` : sql``;
  return sql`(
    ${peripheralPolicies.targetType} = ${'organization'}
    OR (${peripheralPolicies.targetType} = ${'site'}
      AND jsonb_exists_any(${peripheralPolicies.targetIds}->'siteIds', ${siteArray}))
    OR (${peripheralPolicies.targetType} = ${'device'} AND EXISTS (
      SELECT 1 FROM ${devices}
      WHERE ${inArray(devices.siteId, allowedSiteIds)}${deviceOrg}
        AND jsonb_exists(${peripheralPolicies.targetIds}->'deviceIds', ${devices.id}::text)))
    OR (${peripheralPolicies.targetType} = ${'group'} AND EXISTS (
      SELECT 1 FROM ${deviceGroups}
      WHERE ${inArray(deviceGroups.siteId, allowedSiteIds)}${groupOrg}
        AND jsonb_exists(${peripheralPolicies.targetIds}->'groupIds', ${deviceGroups.id}::text)))
  )`;
}

type PolicyTargetsRow = { targetType: string; targetIds: PeripheralPolicyTargetIds | null };

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Narrow each policy's `targetIds` to the sites, groups and devices inside the
 * reader's site ceiling, so a site-restricted reader never sees identifiers
 * from sites they cannot access. Unrestricted readers get rows unchanged.
 */
async function projectPolicyTargetsForReader<T extends PolicyTargetsRow>(
  rows: T[],
  allowedSiteIds: string[] | undefined
): Promise<T[]> {
  if (!allowedSiteIds) return rows;
  const allowed = new Set(allowedSiteIds);

  const deviceIds = [...new Set(rows.flatMap((r) => stringIds(r.targetIds?.deviceIds)))];
  const groupIds = [...new Set(rows.flatMap((r) => stringIds(r.targetIds?.groupIds)))];
  const visibleDevices = new Set<string>();
  const visibleGroups = new Set<string>();
  if (deviceIds.length > 0) {
    const found = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(inArray(devices.id, deviceIds));
    for (const d of found) if (d.siteId && allowed.has(d.siteId)) visibleDevices.add(d.id);
  }
  if (groupIds.length > 0) {
    const found = await db
      .select({ id: deviceGroups.id, siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(inArray(deviceGroups.id, groupIds));
    for (const g of found) if (g.siteId && allowed.has(g.siteId)) visibleGroups.add(g.id);
  }

  return rows.map((row) => {
    const t = row.targetIds ?? {};
    const projected: PeripheralPolicyTargetIds = {};
    if (t.siteIds !== undefined) projected.siteIds = stringIds(t.siteIds).filter((id) => allowed.has(id));
    if (t.groupIds !== undefined) projected.groupIds = stringIds(t.groupIds).filter((id) => visibleGroups.has(id));
    if (t.deviceIds !== undefined) projected.deviceIds = stringIds(t.deviceIds).filter((id) => visibleDevices.has(id));
    return { ...row, targetIds: projected };
  });
}

/** After projection: does this policy still reach anything the reader can see? */
function policyReachesReader(row: PolicyTargetsRow): boolean {
  const t = row.targetIds ?? {};
  switch (row.targetType) {
    case 'organization': return true;
    case 'site': return (t.siteIds?.length ?? 0) > 0;
    case 'group': return (t.groupIds?.length ?? 0) > 0;
    case 'device': return (t.deviceIds?.length ?? 0) > 0;
    default: return false;
  }
}

async function getPolicyWithAccess(policyId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(peripheralPolicies.id, policyId)];
  const accessCondition = peripheralPolicyAccessCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const [policy] = await db
    .select()
    .from(peripheralPolicies)
    .where(and(...conditions))
    .limit(1);

  return policy ?? null;
}

/**
 * The org(s) whose devices a policy applies to (#2131): its own org, or —
 * for a partner-wide policy — every org under the owning partner. Used to
 * fan out the org-keyed distribution jobs and change events.
 */
async function resolvePolicyTargetOrgIds(policy: { orgId: string | null; partnerId: string | null }): Promise<string[]> {
  if (policy.orgId) return [policy.orgId];
  if (!policy.partnerId) return [];
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    // The hidden 'quick_support' org holds only ephemeral support devices — a
    // partner-wide USB/peripheral policy must not fan out into it.
    // Nor into the partner's holding org: parked devices get no policy.
    .where(and(eq(organizations.partnerId, policy.partnerId), ne(organizations.type, 'quick_support'), notHoldingOrgCondition()));
  return rows.map((row) => row.id);
}

async function emitPolicyChanged(
  orgId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await publishEvent(
    'peripheral.policy_changed',
    orgId,
    payload,
    'peripheral-control-routes'
  );
}

/**
 * Fan a policy change out to its target orgs (#2131): schedule the org-keyed
 * distribution job and emit the change event PER ORG, each with its own
 * try/catch — one org's Redis/queue failure must not silently skip the
 * remaining orgs of a partner-wide fan-out. Returns a warning naming how many
 * orgs failed (mirrors processPolicyDistribution's per-device accounting).
 */
async function fanOutPolicyChange(
  targetOrgIds: string[],
  affectedDeviceIds: string[],
  policyId: string,
  reason: string,
  eventPayload: Record<string, unknown>
): Promise<string | undefined> {
  let warning: string | undefined;

  try {
    await schedulePeripheralPolicyDevices(affectedDeviceIds, reason);
  } catch (error) {
    console.error(`[peripheralControl] Failed to schedule policy reconciliation for policy ${policyId}:`, error);
    warning = combineWarning(
      warning,
      `reconciliation scheduling failed for ${affectedDeviceIds.length} device(s)`
    );
  }

  const eventFailures: string[] = [];
  for (const targetOrgId of targetOrgIds) {
    try {
      await emitPolicyChanged(targetOrgId, eventPayload);
    } catch (error) {
      eventFailures.push(targetOrgId);
      console.error(`[peripheralControl] Failed to emit policy change event for policy ${policyId} (org ${targetOrgId}):`, error);
    }
  }
  if (eventFailures.length > 0) {
    warning = combineWarning(
      warning,
      `event publish failed for ${eventFailures.length}/${targetOrgIds.length} org(s): ${eventFailures.join(', ')}`
    );
  }

  return warning;
}

peripheralControlRoutes.get(
  '/activity',
  // Populates `permissions` in context (site-scope narrowing below depends on
  // it) and gates device-telemetry reads behind DEVICES_READ.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listActivityQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(peripheralEvents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (query.orgId) conditions.push(eq(peripheralEvents.orgId, query.orgId));
    if (query.deviceId) conditions.push(eq(peripheralEvents.deviceId, query.deviceId));
    if (query.policyId) conditions.push(eq(peripheralEvents.policyId, query.policyId));
    if (query.eventType) conditions.push(eq(peripheralEvents.eventType, query.eventType));
    if (query.peripheralType) conditions.push(eq(peripheralEvents.peripheralType, query.peripheralType));
    if (query.vendor) conditions.push(eq(peripheralEvents.vendor, query.vendor));
    if (query.product) conditions.push(eq(peripheralEvents.product, query.product));
    if (query.serialNumber) conditions.push(eq(peripheralEvents.serialNumber, query.serialNumber));

    const start = query.start ? new Date(query.start) : null;
    const end = query.end ? new Date(query.end) : null;
    const effectiveStart = start ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const effectiveEnd = end ?? new Date();

    if (effectiveStart.getTime() > effectiveEnd.getTime()) {
      return c.json({ error: 'start must be before or equal to end' }, 400);
    }

    const maxWindowMs = MAX_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if ((effectiveEnd.getTime() - effectiveStart.getTime()) > maxWindowMs) {
      return c.json({ error: `Time range cannot exceed ${MAX_ACTIVITY_WINDOW_DAYS} days` }, 400);
    }

    conditions.push(gte(peripheralEvents.occurredAt, effectiveStart));
    conditions.push(lte(peripheralEvents.occurredAt, effectiveEnd));

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    // Narrow to the caller's accessible devices when site-restricted. RLS does
    // not defend the site axis, so a site-scoped org user must not read events
    // for devices outside their `allowedSiteIds`. Only org-scope users carry
    // `allowedSiteIds`, so `auth.orgId` is present whenever this applies.
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (query.deviceId && !allowedDeviceIds!.includes(query.deviceId)) {
        return c.json({ error: 'Device not found or access denied' }, 403);
      }
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({
          data: [],
          pagination: { total: 0, limit, offset }
        });
      }
      conditions.push(inArray(peripheralEvents.deviceId, allowedDeviceIds));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(peripheralEvents)
      .where(where);

    const rows = await db
      .select()
      .from(peripheralEvents)
      .where(where)
      .orderBy(desc(peripheralEvents.occurredAt), desc(peripheralEvents.createdAt), desc(peripheralEvents.id))
      .limit(limit)
      .offset(offset);

    // Batched name lookups so the Activity Log can show a hostname / policy
    // name instead of a UUID prefix (#9621). Both reads run under the caller's
    // RLS context; an id the caller cannot see simply gets a null name.
    const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
    const policyIds = [...new Set(rows.map((r) => r.policyId).filter((id): id is string => !!id))];
    const [deviceRows, policyRows] = await Promise.all([
      deviceIds.length > 0
        ? db.select({ id: devices.id, hostname: devices.hostname, displayName: devices.displayName })
            .from(devices).where(inArray(devices.id, deviceIds))
        : Promise.resolve([] as { id: string; hostname: string; displayName: string | null }[]),
      policyIds.length > 0
        ? db.select({ id: peripheralPolicies.id, name: peripheralPolicies.name })
            .from(peripheralPolicies).where(inArray(peripheralPolicies.id, policyIds))
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const deviceNames = new Map(deviceRows.map((d) => [d.id, d.displayName || d.hostname]));
    const policyNames = new Map(policyRows.map((p) => [p.id, p.name]));

    return c.json({
      data: rows.map((row) => ({
        ...row,
        deviceName: deviceNames.get(row.deviceId) ?? null,
        policyName: row.policyId ? policyNames.get(row.policyId) ?? null : null,
      })),
      pagination: {
        total: Number(countRow?.count ?? 0),
        limit,
        offset
      }
    });
  }
);

peripheralControlRoutes.get(
  '/policies',
  // Gate peripheral-policy reads behind DEVICES_READ, matching `/activity`.
  // Without this, any in-org user of any role could read the org's USB/
  // peripheral security posture (RLS contains it to their org, but intra-tenant
  // RBAC must still apply).
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const conditions: SQL[] = [];
    // Dual-axis (#2131): partner-scope callers also see their partner-wide
    // policies in the list, not just via get-by-id.
    const accessCondition = peripheralPolicyAccessCondition(auth);
    if (accessCondition) conditions.push(accessCondition);

    // With a client selected, the list is that org's rows PLUS its partner's
    // partner-wide rows (org_id NULL) — they apply to the client too (#9621).
    // The partner-wide branch is read-only here and still bounded by
    // `accessCondition` above (and by RLS: only partner-scope callers can
    // SELECT partner-owned rows).
    if (query.orgId) {
      conditions.push(sql`(${eq(peripheralPolicies.orgId, query.orgId)} OR (${peripheralPolicies.orgId} IS NULL AND ${peripheralPolicies.partnerId} = (SELECT ${organizations.partnerId} FROM ${organizations} WHERE ${eq(organizations.id, query.orgId)})))`);
    }
    if (query.isActive !== undefined) conditions.push(eq(peripheralPolicies.isActive, query.isActive === 'true'));
    if (query.action) conditions.push(eq(peripheralPolicies.action, query.action));
    if (query.deviceClass) conditions.push(eq(peripheralPolicies.deviceClass, query.deviceClass));
    const siteCeiling = readerSiteCeiling(auth);
    if (siteCeiling) conditions.push(peripheralPolicySiteVisibilityCondition(siteCeiling, auth.orgId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(peripheralPolicies)
      .where(where);

    const rows = await db
      .select()
      .from(peripheralPolicies)
      .where(where)
      .orderBy(desc(peripheralPolicies.updatedAt), desc(peripheralPolicies.id))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: await projectPolicyTargetsForReader(rows, siteCeiling),
      pagination: {
        total: Number(countRow?.count ?? 0),
        limit,
        offset
      }
    });
  }
);

/**
 * The peripheral policies that actually apply to ONE device (#9621): the
 * resolver's effective set (site/group/device targeting, partner-wide rows),
 * not every active policy of the org. Authorisation happens here, before the
 * system-context resolver runs: the device must be in a caller-accessible org
 * and, for a site-restricted caller, in one of their sites.
 */
peripheralControlRoutes.get(
  '/devices/:deviceId/effective',
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', z.object({ deviceId: z.string().guid() })),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { deviceId } = c.req.valid('param');

    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device || !auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const resolved = await loadAndResolveEffectivePeripheralPolicySet(deviceId);
    // null = the device's organization row is missing (data-integrity problem),
    // which must not read as "no policies apply".
    if (!resolved) return c.json({ error: 'Device not found' }, 404);
    if (resolved.effectivePolicies.length === 0) return c.json({ data: [] });

    // Names/targeting for exactly the policies the resolver says apply to this
    // (already authorised) device — including partner-wide rows an org-scope
    // caller's RLS would not let them SELECT directly.
    const policyIds = resolved.effectivePolicies.map((p) => p.policyId);
    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db
        .select({ id: peripheralPolicies.id, name: peripheralPolicies.name, targetType: peripheralPolicies.targetType })
        .from(peripheralPolicies)
        .where(inArray(peripheralPolicies.id, policyIds))));
    const byId = new Map(rows.map((r) => [r.id, r]));

    return c.json({
      data: resolved.effectivePolicies.map((p) => ({
        id: p.policyId,
        name: byId.get(p.policyId)?.name ?? null,
        source: p.source,
        deviceClass: p.effectiveClass,
        action: p.action,
        targetType: byId.get(p.policyId)?.targetType ?? null,
        priority: p.priority,
      })),
    });
  }
);

peripheralControlRoutes.get(
  '/policies/:id',
  // Gate peripheral-policy reads behind DEVICES_READ, matching `/activity`.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', disablePolicyParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    const siteCeiling = readerSiteCeiling(auth);
    if (!siteCeiling) return c.json({ data: policy });
    // Same visibility and target narrowing as the list.
    const [visible] = await projectPolicyTargetsForReader([policy], siteCeiling);
    if (!visible || !policyReachesReader(visible)) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ data: visible });
  }
);

peripheralControlRoutes.post(
  '/policies',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', policySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const payload = c.req.valid('json');

    const policyId = payload.id;
    const now = new Date();

    if (policyId) {
      const existing = await getPolicyWithAccess(policyId, auth);
      if (!existing) {
        return c.json({ error: 'Policy not found' }, 404);
      }

      // Partner-wide templates are administrable only with the partner-wide
      // capability (#2131).
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }

      const oldDeviceIds = await resolvePeripheralPolicyDeviceIds(existing);
      const targeting = resolveUpdateTargeting(payload, existing);

      const [updated] = await db
        .update(peripheralPolicies)
        .set({
          name: payload.name,
          deviceClass: payload.deviceClass,
          action: payload.action,
          targetType: targeting.targetType,
          priority: payload.priority ?? existing.priority,
          targetIds: targeting.targetIds,
          // undefined = unchanged; an explicit [] clears
          ...(payload.exceptions !== undefined ? { exceptions: payload.exceptions } : {}),
          isActive: payload.isActive ?? existing.isActive,
          updatedAt: now
        })
        .where(eq(peripheralPolicies.id, existing.id))
        .returning();

      if (!updated) {
        return c.json({ error: 'Failed to update policy' }, 500);
      }

      const updateTargetOrgIds = await resolvePolicyTargetOrgIds(updated);
      const newDeviceIds = await resolvePeripheralPolicyDeviceIds(updated);
      const distributionWarning = await fanOutPolicyChange(updateTargetOrgIds, [...new Set([...oldDeviceIds, ...newDeviceIds])], updated.id, 'policy-updated', {
        policyId: updated.id,
        action: 'updated',
        changedBy: auth.user.id
      });

      try {
        writeRouteAudit(c, {
          orgId: updated.orgId,
          action: 'peripheral.policy.update',
          resourceType: 'peripheral_policy',
          resourceId: updated.id,
          resourceName: updated.name,
          details: {
            deviceClass: updated.deviceClass,
            actionMode: updated.action,
            targetType: updated.targetType,
            distributionWarning
          }
        });
      } catch (error) {
        console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
      }

      return c.json({ data: updated, warning: distributionWarning });
    }

    // Resolve the ownership axis (#2131): partner-wide creation requires the
    // partner-wide capability; the default path stays org-owned.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgResolution = resolveOrgIdForWrite(auth, payload.orgId);
      if (!orgResolution.orgId) {
        return c.json({ error: orgResolution.error ?? 'Organization resolution failed' }, orgResolution.status ?? 400);
      }
      owner = { orgId: orgResolution.orgId, partnerId: null };
    }

    const [created] = await db
      .insert(peripheralPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: payload.name,
        deviceClass: payload.deviceClass,
        action: payload.action,
        targetType: payload.targetType ?? 'organization',
        priority: payload.priority ?? 100,
        targetIds: sanitizeTargetIds(payload.targetIds ?? {}),
        exceptions: payload.exceptions ?? [],
        isActive: payload.isActive ?? true,
        createdBy: auth.user.id,
      })
      .returning();

    if (!created) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    const createTargetOrgIds = await resolvePolicyTargetOrgIds(created);
    const createDeviceIds = await resolvePeripheralPolicyDeviceIds(created);
    const distributionWarning = await fanOutPolicyChange(createTargetOrgIds, createDeviceIds, created.id, 'policy-created', {
      policyId: created.id,
      action: 'created',
      changedBy: auth.user.id
    });

    try {
      writeRouteAudit(c, {
        orgId: created.orgId,
        action: 'peripheral.policy.create',
        resourceType: 'peripheral_policy',
        resourceId: created.id,
        resourceName: created.name,
        details: {
          deviceClass: created.deviceClass,
          actionMode: created.action,
          targetType: created.targetType,
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${created.id}:`, error);
    }

    return c.json({ data: created, warning: distributionWarning }, 201);
  }
);

peripheralControlRoutes.post(
  '/policies/:id/disable',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', disablePolicyParamSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Partner-wide templates are administrable only with the partner-wide
    // capability (#2131).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const disableDeviceIds = await resolvePeripheralPolicyDeviceIds(policy);

    const [updated] = await db
      .update(peripheralPolicies)
      .set({
        isActive: false,
        updatedAt: new Date()
      })
      .where(eq(peripheralPolicies.id, policy.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to disable policy' }, 500);
    }

    const disableTargetOrgIds = await resolvePolicyTargetOrgIds(updated);
    const distributionWarning = await fanOutPolicyChange(disableTargetOrgIds, disableDeviceIds, updated.id, 'policy-disabled', {
      policyId: updated.id,
      action: 'disabled',
      changedBy: auth.user.id
    });

    try {
      writeRouteAudit(c, {
        orgId: updated.orgId,
        action: 'peripheral.policy.disable',
        resourceType: 'peripheral_policy',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
    }

    return c.json({ data: updated, warning: distributionWarning });
  }
);

peripheralControlRoutes.post(
  '/exceptions',
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', exceptionsSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const payload = c.req.valid('json');

    const policy = await getPolicyWithAccess(payload.policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Partner-wide templates are administrable only with the partner-wide
    // capability (#2131).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const currentExceptions = Array.isArray(policy.exceptions)
      ? policy.exceptions as PeripheralExceptionRule[]
      : [];

    let nextExceptions = currentExceptions;
    let changed = 0;

    if (payload.operation === 'add') {
      const nextRule = normalizeExceptionRule(payload.exception);
      if (!nextRule) {
        return c.json({ error: 'Invalid exception rule' }, 400);
      }
      nextExceptions = [...currentExceptions, nextRule];
      changed = 1;
    } else {
      const match = payload.match!;
      nextExceptions = currentExceptions.filter((rule) => {
        const vendorMatch = match.vendor ? rule.vendor === match.vendor : true;
        const productMatch = match.product ? rule.product === match.product : true;
        const serialMatch = match.serialNumber ? rule.serialNumber === match.serialNumber : true;
        const shouldRemove = vendorMatch && productMatch && serialMatch;
        if (shouldRemove) changed++;
        return !shouldRemove;
      });
    }

    if (payload.operation === 'remove' && changed === 0) {
      return c.json({ error: 'No matching exception rule found' }, 404);
    }

    const [updated] = await db
      .update(peripheralPolicies)
      .set({
        exceptions: nextExceptions,
        updatedAt: new Date()
      })
      .where(eq(peripheralPolicies.id, policy.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update policy exceptions' }, 500);
    }

    const exceptionsTargetOrgIds = await resolvePolicyTargetOrgIds(updated);
    const exceptionsDeviceIds = await resolvePeripheralPolicyDeviceIds(updated);
    const distributionWarning = await fanOutPolicyChange(exceptionsTargetOrgIds, exceptionsDeviceIds, updated.id, 'policy-exceptions-updated', {
      policyId: updated.id,
      action: 'exceptions_updated',
      changedBy: auth.user.id,
      operation: payload.operation,
      changed
    });

    try {
      writeRouteAudit(c, {
        orgId: updated.orgId,
        action: 'peripheral.policy.exceptions',
        resourceType: 'peripheral_policy',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          operation: payload.operation,
          changed,
          distributionWarning
        }
      });
    } catch (error) {
      console.error(`[peripheralControl] Failed to write audit for policy ${updated.id}:`, error);
    }

    return c.json({
      data: updated,
      changed,
      warning: distributionWarning
    });
  }
);
