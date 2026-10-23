import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import type { YaraThreatRuleView } from '@breeze/shared';

import { db } from '../../db';
import { devices } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import {
  listThreatsQuerySchema,
  deviceIdParamSchema,
  threatIdParamSchema
} from './schemas';
import {
  getPagination,
  paginate,
  parseDateRange,
  matchDateRange,
  listStatusRows,
  listThreatRows,
  loadThreatForCaller,
  queueThreatAction,
  toThreatListItem,
  toThreatRow
} from './helpers';
import { requireSecurityReadAccess } from './readAuthorization';
import { loadVisibleSet } from './yaraAccess';

export const threatsRoutes = new Hono();

threatsRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let threats = await listThreatRows(auth, undefined, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.deviceName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const mapped = threats.map(toThreatListItem);

    const response = paginate(mapped, page, limit);
    return c.json({
      ...response,
      summary: {
        total: threats.length,
        active: threats.filter((t) => t.status === 'active').length,
        quarantined: threats.filter((t) => t.status === 'quarantined').length,
        critical: threats.filter((t) => t.severity === 'critical').length
      }
    });
  }
);

threatsRoutes.get(
  '/threats/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const statuses = await listStatusRows(auth);
    if (!statuses.some((row) => row.deviceId === deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Site-scope gate: partner-scope users restricted via `allowedSiteIds`
    // must not see threats for devices in sites they cannot access. RLS does
    // not defend the site axis — mirrors PR #864/#868.
    let userPerms = c.get('permissions') as UserPermissions | undefined;
    if (!userPerms) {
      const fetched = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined,
      });
      userPerms = fetched || undefined;
    }
    if (userPerms?.allowedSiteIds) {
      const [device] = await db
        .select({ siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!device || typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
    }

    let threats = await listThreatRows(auth, deviceId, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(threats.map(toThreatListItem), page, limit);

    return c.json(response);
  }
);

// ---------------------------------------------------------------------------
// Threat details (#6263 W04-5)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDENT = 128;
const MAX_TAGS = 32;
const MAX_MATCHED_STRINGS = 10;
/** The agent caps matched data at 128 bytes before `\xNN` escaping. */
const MAX_MATCHED_DATA = 512;

function identOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_IDENT) : null;
}

/**
 * Typed projection of the agent-reported `security_threats.details`
 * (agent/internal/security/threats.go). Every field is type-checked and junk
 * is dropped, never passed through. matchedStrings[].data is already escaped
 * by the agent (escapeMatched): it is truncated here, never escaped again.
 */
export function toYaraThreatRuleView(details: unknown, ruleSet: YaraThreatRuleView['ruleSet']): YaraThreatRuleView {
  const d = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
  const ruleName = identOrNull(d.ruleName);
  const ruleSetId = typeof d.ruleSetId === 'string' && UUID_RE.test(d.ruleSetId) ? d.ruleSetId.toLowerCase() : null;
  const tags = Array.isArray(d.tags)
    ? d.tags.filter((t): t is string => typeof t === 'string').slice(0, MAX_TAGS).map((t) => t.slice(0, MAX_IDENT))
    : [];
  const matchedStrings: YaraThreatRuleView['matchedStrings'] = [];
  if (Array.isArray(d.matchedStrings)) {
    for (const s of d.matchedStrings) {
      if (matchedStrings.length >= MAX_MATCHED_STRINGS) break;
      if (!s || typeof s !== 'object') continue;
      const { id, offset, data } = s as Record<string, unknown>;
      if (typeof id !== 'string' || typeof data !== 'string') continue;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) continue;
      matchedStrings.push({ id: id.slice(0, MAX_IDENT), offset, data: data.slice(0, MAX_MATCHED_DATA) });
    }
  }
  return {
    engine: ruleName ? 'yara' : 'legacy',
    ruleName,
    ruleId: identOrNull(d.ruleId),
    ruleSetId,
    ruleSet,
    tags,
    matchedStrings,
    sha256: typeof d.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(d.sha256) ? d.sha256.toLowerCase() : null,
    quarantinedTo: typeof d.quarantinedTo === 'string' && d.quarantinedTo.length > 0 ? d.quarantinedTo.slice(0, 4096) : null,
    quarantineFailed: d.quarantineFailed === true,
  };
}

// Two segments, so it cannot collide with GET /threats/:deviceId. The threat
// comes back in the list-item shape, so ThreatDetail does not depend on the
// selected threat being in the first page of GET /threats.
threatsRoutes.get(
  '/threats/:id/details',
  requireScope('organization', 'partner', 'system'),
  // devices:read for tenant callers; live platform admins in system scope.
  requireSecurityReadAccess,
  zValidator('param', threatIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const loaded = await loadThreatForCaller(c, id);
    if (!('threat' in loaded)) {
      return c.json({ error: loaded.error }, loaded.status);
    }
    const { threat } = loaded;

    let ruleSet: YaraThreatRuleView['ruleSet'] = null;
    const projected = toYaraThreatRuleView(threat.details, null);
    if (projected.ruleSetId) {
      // Joined under the caller's RLS and W03's visibility condition; null =
      // "no longer available" (deleted, or not visible to this caller).
      const set = await loadVisibleSet(auth, projected.ruleSetId);
      if (set) {
        ruleSet = { id: set.id, name: set.name, isBuiltin: set.isBuiltin, partnerWide: set.orgId === null && !set.isBuiltin };
      }
    }

    return c.json({
      data: {
        threat: toThreatListItem(toThreatRow(threat)),
        rule: { ...projected, ruleSet },
      },
    });
  }
);

// These dispatch destructive agent commands (quarantine/remove/restore a
// threat on a device). requireScope only checks tenancy tier, not role — a
// read-only Org Viewer would otherwise pass. Gate on device-execute, matching
// sensitiveData /scan and /remediate (DEVICES_EXECUTE).
threatsRoutes.post(
  '/threats/:id/quarantine',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'quarantine')
);

threatsRoutes.post(
  '/threats/:id/remove',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'remove')
);

threatsRoutes.post(
  '/threats/:id/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'restore')
);
