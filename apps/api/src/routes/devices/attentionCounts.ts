import { Hono } from 'hono';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../../db';
import { alerts, devices, tickets } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { PG_UUID_REGEX } from '../../utils/uuid';
import { alertTopologySiteGate } from '../alerts/helpers';
import { buildDeviceScope } from './scope';

/**
 * GET /devices/attention-counts?ids=<uuid>,<uuid>,… — the devices list's
 * "Attention" column (#9038): per device, open alerts by severity and open
 * tickets, for one page of rows at a time.
 *
 * Same "needs a look" semantics as GET /devices/:id/tab-counts:
 *   alerts   active + acknowledged (not resolved/suppressed/dismissed),
 *            behind the same topology-site gate
 *   tickets  not resolved/closed, not soft-deleted
 *
 * Exactly two statements regardless of page size (one GROUP BY per table).
 * Both join the device row and apply the device list's own tenant narrowing
 * (`buildDeviceScope`: org condition + site allowlist) on top of RLS, so an id
 * the caller cannot see in the list simply yields no entry — never an error
 * that would confirm the id exists. Devices with nothing open get no key.
 */
export const attentionCountsRoutes = new Hono();

attentionCountsRoutes.use('*', authMiddleware);

export const MAX_ATTENTION_IDS = 100;

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

export type DeviceAttentionCounts = {
  alerts: Record<Severity, number>;
  tickets: number;
};

const OPEN_ALERT_STATUSES = ['active', 'acknowledged'] as const;
const OPEN_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

const countExpr = sql<number>`count(*)`;

function emptyCounts(): DeviceAttentionCounts {
  return { alerts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, tickets: 0 };
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/** Parse `ids`: comma-separated, trimmed, empties dropped, deduped (first-seen order). */
function parseIds(raw: string | undefined): { ids: string[] } | { error: string } {
  if (raw === undefined) return { error: 'ids query parameter is required' };
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length > MAX_ATTENTION_IDS) {
    return { error: `At most ${MAX_ATTENTION_IDS} ids per request` };
  }
  if (entries.some((id) => !PG_UUID_REGEX.test(id))) {
    return { error: 'ids must be UUIDs' };
  }
  return { ids: [...new Set(entries.map((id) => id.toLowerCase()))] };
}

attentionCountsRoutes.get(
  '/attention-counts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const parsed = parseIds(c.req.query('ids'));
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }
    const { ids } = parsed;
    if (ids.length === 0) {
      return c.json({ counts: {} });
    }

    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const scoped = buildDeviceScope(auth, permissions, undefined);
    // No ?orgId is passed, so `forbidden` cannot occur; an empty site
    // allowlist sees no devices in the list, so it sees no counts either.
    if (!('scope' in scoped)) {
      return c.json({ counts: {} });
    }

    const [alertRows, ticketRows] = await Promise.all([
      db
        .select({ deviceId: alerts.deviceId, severity: alerts.severity, count: countExpr })
        .from(alerts)
        .innerJoin(devices, eq(devices.id, alerts.deviceId))
        .where(
          and(
            inArray(alerts.deviceId, ids),
            scoped.scope,
            inArray(alerts.status, [...OPEN_ALERT_STATUSES]),
            alertTopologySiteGate(auth.allowedSiteIds),
          ),
        )
        .groupBy(alerts.deviceId, alerts.severity),
      db
        .select({ deviceId: tickets.deviceId, count: countExpr })
        .from(tickets)
        .innerJoin(devices, eq(devices.id, tickets.deviceId))
        .where(
          and(
            inArray(tickets.deviceId, ids),
            scoped.scope,
            isNull(tickets.deletedAt),
            inArray(tickets.status, [...OPEN_TICKET_STATUSES]),
          ),
        )
        .groupBy(tickets.deviceId),
    ]);

    const counts: Record<string, DeviceAttentionCounts> = {};
    const entryFor = (deviceId: string) => (counts[deviceId] ??= emptyCounts());

    for (const row of alertRows) {
      const n = Number(row.count);
      if (!row.deviceId || !isSeverity(row.severity) || !(n > 0)) continue;
      entryFor(row.deviceId).alerts[row.severity] += n;
    }
    for (const row of ticketRows) {
      const n = Number(row.count);
      if (!row.deviceId || !(n > 0)) continue;
      entryFor(row.deviceId).tickets += n;
    }

    return c.json({ counts });
  },
);
