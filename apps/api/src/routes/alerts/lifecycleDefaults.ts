import { Hono } from 'hono';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ALERT_LIFECYCLE_FIELDS,
  alertLifecycleDefaultsQuerySchema,
  alertLifecycleDefaultsSchema,
  resolveAlertLifecycle,
  type AlertLifecycleDefaultsResponse,
  type AlertLifecycleValues,
  type PartialLifecycle,
} from '@breeze/shared';
import { db } from '../../db';
import { monitorDefinitions, organizations, partners } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { readOrgLifecycleOverride, readPartnerLifecycleDefaults } from '../../services/alertLifecycle/resolve';
import { writeRouteAudit } from '../../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import { PERMISSIONS } from '../../services/permissions';

/**
 * "Lifecycle defaults" (spec 2026-10-29-alert-rearm-lifecycle §6.5): the partner
 * default and org override of auto-resolve, re-arm and cooldown. One home per
 * level; the monitor override lives on the monitor.
 *
 * Gates (plan ND2):
 * - read: ALERTS_READ. An org user sees the partner value it inherits; that value
 *   is not sensitive, and showing the source is what settings rule 4 asks for.
 * - partner write: ALERTS_WRITE + canManagePartnerWidePolicies (full partner org
 *   access or system scope), because the value reaches every org.
 * - org write: ALERTS_WRITE + access to that org.
 * - both writes: no site or exact-device ceiling (canMutateOrgWideGovernance),
 *   like every other org-wide alerting write (channels, routing rules).
 */
const AUDIT_ACTION = 'alert.lifecycle_defaults.update';

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

type OrgOverride = NonNullable<Awaited<ReturnType<typeof readOrgLifecycleOverride>>>;
type OrgLookup = { org: OrgOverride } | { error: string; status: 403 | 404 };

/** Access-check an org, then read it in the caller's RLS context. */
async function lookUpOrg(auth: AuthContext, orgId: string): Promise<OrgLookup> {
  if (!auth.canAccessOrg(orgId)) return { error: 'Access to this organization denied', status: 403 };
  const org = await readOrgLifecycleOverride(orgId);
  // RLS already hides another partner's org; the pin is the defence in depth.
  if (!org || (auth.scope === 'partner' && org.partnerId !== auth.partnerId)) {
    return { error: 'Organization not found', status: 404 };
  }
  return { org };
}

/**
 * How many monitors in scope set each field themselves. Selected org: its own
 * monitors plus its partner's partner-wide ones. Partner level: every monitor
 * the caller can see under the partner (RLS narrows a selected-access user).
 */
async function countMonitorOverrides(
  orgId: string | null,
  partnerId: string | null,
): Promise<Record<keyof AlertLifecycleValues, number>> {
  const partnerWide = partnerId ? and(isNull(monitorDefinitions.orgId), eq(monitorDefinitions.partnerId, partnerId)) : undefined;
  const scope = orgId
    ? or(eq(monitorDefinitions.orgId, orgId), partnerWide)
    : or(
        partnerWide,
        inArray(
          monitorDefinitions.orgId,
          db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partnerId!)),
        ),
      );
  const [counts] = await db
    .select({
      autoResolve: sql<number>`count(*) FILTER (WHERE ${monitorDefinitions.autoResolve} IS NOT NULL)::int`,
      rearmMode: sql<number>`count(*) FILTER (WHERE ${monitorDefinitions.rearmMode} IS NOT NULL)::int`,
      rearmDelayMinutes: sql<number>`count(*) FILTER (WHERE ${monitorDefinitions.rearmDelayMinutes} IS NOT NULL)::int`,
      cooldownMinutes: sql<number>`count(*) FILTER (WHERE ${monitorDefinitions.cooldownMinutes} IS NOT NULL)::int`,
    })
    .from(monitorDefinitions)
    .where(scope);
  return Object.fromEntries(
    ALERT_LIFECYCLE_FIELDS.map((field) => [field, Number(counts?.[field] ?? 0)]),
  ) as Record<keyof AlertLifecycleValues, number>;
}

async function buildResponse(
  orgId: string | null,
  org: OrgOverride | null,
  partnerId: string | null,
): Promise<AlertLifecycleDefaultsResponse> {
  const partnerValues: PartialLifecycle | null = partnerId ? await readPartnerLifecycleDefaults(partnerId) : null;
  const { sources: _partnerSources, ...partner } = resolveAlertLifecycle({ partner: partnerValues });
  const { sources, ...effective } = resolveAlertLifecycle({ org: org?.values ?? null, partner: partnerValues });
  return {
    partner,
    org: org ? org.values : null,
    effective,
    sources,
    monitorOverrideCounts: await countMonitorOverrides(orgId, partnerId),
  };
}

export const lifecycleDefaultsRoutes = new Hono();

lifecycleDefaultsRoutes.get(
  '/lifecycle-defaults',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', alertLifecycleDefaultsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const requested = c.req.valid('query').orgId;
    // An org-scoped caller is pinned to its own org; the partner level is not its view.
    const orgId = requested ?? (auth.scope === 'organization' ? auth.orgId : null);
    if (auth.scope === 'organization' && !orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    if (orgId) {
      const lookup = await lookUpOrg(auth, orgId);
      if ('error' in lookup) return c.json({ error: lookup.error }, lookup.status);
      return c.json(await buildResponse(orgId, lookup.org, lookup.org.partnerId));
    }

    if (!auth.partnerId) return c.json({ error: 'orgId is required without a partner context' }, 400);
    return c.json(await buildResponse(null, null, auth.partnerId));
  },
);

lifecycleDefaultsRoutes.put(
  '/lifecycle-defaults',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', alertLifecycleDefaultsSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    // Either level reaches every device in the org (or partner): a caller
    // narrowed to some sites or devices has nothing it may change here.
    if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    const values = {
      autoResolve: body.autoResolve,
      rearmMode: body.rearmMode,
      rearmDelayMinutes: body.rearmDelayMinutes,
      cooldownMinutes: body.cooldownMinutes,
    };

    if (body.scope === 'partner') {
      // Fails closed for every org-scoped context (no partner membership).
      if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
      const rows = await db
        .update(partners)
        .set({
          alertAutoResolve: body.autoResolve,
          alertRearmMode: body.rearmMode,
          alertRearmDelayMinutes: body.rearmDelayMinutes,
          alertCooldownMinutes: body.cooldownMinutes,
          updatedAt: new Date(),
        })
        .where(eq(partners.id, auth.partnerId))
        .returning({ id: partners.id });
      if (rows.length === 0) return c.json({ error: 'Partner not found' }, 404);
      writeRouteAudit(c, {
        orgId: null,
        partnerId: auth.partnerId,
        action: AUDIT_ACTION,
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: { level: 'partner', ...values },
      });
      return c.json(await buildResponse(null, null, auth.partnerId));
    }

    const lookup = await lookUpOrg(auth, body.orgId);
    if ('error' in lookup) return c.json({ error: lookup.error }, lookup.status);
    const rows = await db
      .update(organizations)
      .set({
        alertAutoResolve: body.autoResolve,
        alertRearmMode: body.rearmMode,
        alertRearmDelayMinutes: body.rearmDelayMinutes,
        alertCooldownMinutes: body.cooldownMinutes,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, body.orgId))
      .returning({ id: organizations.id });
    if (rows.length === 0) return c.json({ error: 'Organization not found' }, 404);
    writeRouteAudit(c, {
      orgId: body.orgId,
      action: AUDIT_ACTION,
      resourceType: 'organization',
      resourceId: body.orgId,
      details: { level: 'organization', ...values },
    });
    return c.json(await buildResponse(body.orgId, { partnerId: lookup.org.partnerId, values }, lookup.org.partnerId));
  },
);
