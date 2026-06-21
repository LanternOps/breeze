import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, and, ilike, sql, or, gte, lte, SQL } from 'drizzle-orm';
import { db } from '../../db';
import { auditLogs, users } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const eventsRoutes = new Hono();

eventsRoutes.use('*', authMiddleware);

// Bounded enum for event categories — kept intentionally small; new actions
// fall back to the prefix-derived category but cannot be filtered through the
// query API unless added here.
const eventCategoryEnum = z.enum([
  'device',
  'agent',
  'script',
  'patch',
  'alert',
  'policy',
  'deployment',
  'backup',
  'discovery',
  'automation',
  'maintenance',
  'monitoring',
  'ai',
  'software',
  'system',
]);

const eventsParamSchema = z.object({
  id: z.string().guid(),
});

// Build a case-sensitive LIKE prefix pattern from a user-supplied action prefix.
// The three LIKE metacharacters (% _ \) are escaped so a value like `device_x`
// matches the literal underscore instead of acting as a single-char wildcard;
// the trailing `%` makes it a prefix match. Postgres' default LIKE escape is `\`.
export function likePrefixPattern(prefix: string): string {
  return prefix.replace(/[%_\\]/g, '\\$&') + '%';
}

const eventsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: eventCategoryEnum.optional(),
  result: z.enum(['success', 'failure', 'denied']).optional(),
  initiatedBy: z
    .enum(['manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration'])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Server-side "deliberate action" filter for the device-overview Activity
  // pane (issue #1726). Comma-separated list of action prefixes; a row matches
  // if its action starts with any of them. Lets the overview feed request only
  // the rows it renders instead of over-fetching and filtering client-side.
  actions: z
    .string()
    .max(500)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    ),
  // Whether to run the parallel unbounded count(*) over the same predicate.
  // Defaults to false so the common "last N" feed read does not pay for a full
  // history count on every load (issue #1726). When false, pagination.total is
  // null. Set true only when a total is actually rendered.
  withTotal: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

// GET /devices/:id/events - Get activity feed for a device from audit logs
eventsRoutes.get(
  '/:id/events',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', eventsParamSchema),
  zValidator('query', eventsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { search, category, result, initiatedBy, from, to, page, limit, actions, withTotal } =
      c.req.valid('query');
    const offset = (page - 1) * limit;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Find audit logs where resourceId matches the device, OR the device is
    // referenced inside the JSONB details (agent-submitted events use
    // details.deviceId).
    const conditions: SQL[] = [
      or(
        eq(auditLogs.resourceId, deviceId),
        sql`${auditLogs.details}->>'deviceId' = ${deviceId}`
      )!,
    ];

    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(auditLogs.action, term),
          ilike(auditLogs.resourceName, term),
          sql`${auditLogs.details}::text ILIKE ${term}`
        )!
      );
    }

    if (category) {
      // Filter by action prefix category
      conditions.push(ilike(auditLogs.action, `${category}.%`));
    }

    if (actions && actions.length > 0) {
      // Match any of the supplied action prefixes (server-side equivalent of the
      // overview pane's "deliberate action" filter). `LIKE` with an escaped
      // prefix keeps it index-friendly and avoids ILIKE's case-fold cost — audit
      // action keys are already lowercase dotted identifiers.
      conditions.push(
        or(...actions.map((prefix) => sql`${auditLogs.action} LIKE ${likePrefixPattern(prefix)}`))!
      );
    }

    if (result) {
      conditions.push(eq(auditLogs.result, result));
    }

    if (initiatedBy) {
      conditions.push(eq(auditLogs.initiatedBy, initiatedBy));
    }

    if (from) {
      conditions.push(gte(auditLogs.timestamp, from));
    }
    if (to) {
      conditions.push(lte(auditLogs.timestamp, to));
    }

    const whereClause = and(...conditions);

    // The total count is an unbounded count(*) over the device's whole audit
    // history; only run it when the caller actually renders a total. The feed
    // read itself is a bounded ORDER BY timestamp DESC LIMIT N (issue #1726).
    const countPromise = withTotal
      ? db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(whereClause)
          .then((r) => r[0]?.count ?? 0)
      : Promise.resolve(null);

    const [countResult, rows] = await Promise.all([
      countPromise,
      db
        .select({
          id: auditLogs.id,
          timestamp: auditLogs.timestamp,
          action: auditLogs.action,
          actorType: auditLogs.actorType,
          actorEmail: auditLogs.actorEmail,
          actorId: auditLogs.actorId,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          resourceName: auditLogs.resourceName,
          result: auditLogs.result,
          details: auditLogs.details,
          errorMessage: auditLogs.errorMessage,
          ipAddress: auditLogs.ipAddress,
          initiatedBy: auditLogs.initiatedBy,
          actorName: users.name,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.actorId, users.id))
        .where(whereClause)
        .orderBy(desc(auditLogs.timestamp))
        .limit(limit)
        .offset(offset),
    ]);

    const total = countResult === null ? null : Number(countResult);

    const data = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp.toISOString(),
      action: row.action,
      message: formatActionMessage(row.action, row.resourceName, row.result),
      category: deriveCategory(row.action),
      result: row.result,
      actor: {
        type: row.actorType,
        name: row.actorName || row.actorEmail || resolveActorLabel(row.actorType, row.actorId),
        email: row.actorEmail,
      },
      resource: {
        type: row.resourceType,
        id: row.resourceId,
        name: row.resourceName,
      },
      initiatedBy: row.initiatedBy,
      details: row.details as Record<string, unknown> | null,
      errorMessage: row.errorMessage,
      ipAddress: row.ipAddress,
    }));

    return c.json({
      data,
      pagination: { page, limit, total },
    });
  }
);

function resolveActorLabel(actorType: string, actorId: string): string {
  if (actorType === 'agent') return 'Agent';
  if (actorType === 'api_key') return 'API Key';
  if (actorType === 'system') return 'System';
  return 'Unknown';
}

function deriveCategory(action: string): string {
  if (action.startsWith('device.')) return 'device';
  if (action.startsWith('agent.')) return 'agent';
  if (action.startsWith('script.')) return 'script';
  if (action.startsWith('patch.') || action.startsWith('device.patch.')) return 'patch';
  if (action.startsWith('alert.')) return 'alert';
  if (action.startsWith('config_policy.')) return 'policy';
  if (action.startsWith('deployment.') || action.startsWith('software.deployment.')) return 'deployment';
  if (action.startsWith('backup.')) return 'backup';
  if (action.startsWith('discovery.')) return 'discovery';
  if (action.startsWith('automation.')) return 'automation';
  if (action.startsWith('update_ring.')) return 'patch';
  if (action.startsWith('maintenance_')) return 'maintenance';
  if (action.startsWith('monitor.')) return 'monitoring';
  if (action.startsWith('ai.')) return 'ai';
  if (action.startsWith('software.') || action.startsWith('software_policy.')) return 'software';
  return 'system';
}

const actionLabels: Record<string, string> = {
  'agent.enroll': 'Agent enrolled',
  'agent.command.result.submit': 'Command result submitted',
  'agent.eventlogs.submit': 'Event logs submitted',
  'agent.patches.submit': 'Patch status reported',
  'agent.reliability.submit': 'Reliability data reported',
  'agent.security_status.submit': 'Security status reported',
  'agent.sessions.submit': 'Sessions reported',
  'agent.management_posture.submit': 'Management posture reported',
  'agent.mtls.renewed': 'mTLS certificate renewed',
  'agent.mtls.quarantined': 'Device quarantined (mTLS)',
  'agent.filesystem.threshold_scan.queued': 'Disk threshold scan queued',
  'device.command.queue': 'Command queued',
  'device.update': 'Device updated',
  'device.decommission': 'Device decommissioned',
  'device.agent_token.rotate': 'Agent token rotated',
  'device.patch.install.queue': 'Patch installation queued',
  'device.patch.rollback.queue': 'Patch rollback queued',
  'device.filesystem.scan': 'Filesystem scan started',
  'device.filesystem.cleanup.preview': 'Disk cleanup previewed',
  'device.filesystem.cleanup.execute': 'Disk cleanup executed',
  'device.maintenance.enable': 'Maintenance mode enabled',
  'device.maintenance.disable': 'Maintenance mode disabled',
  'script.execute': 'Script executed',
  'script.execution.cancel': 'Script execution cancelled',
  'alert.acknowledge': 'Alert acknowledged',
  'alert.resolve': 'Alert resolved',
  'alert.suppress': 'Alert suppressed',
  'config_policy.assign': 'Configuration policy assigned',
  'config_policy.unassign': 'Configuration policy unassigned',
  'deployment.create': 'Software deployment created',
  'deployment.start': 'Software deployment started',
  'deployment.cancel': 'Software deployment cancelled',
  'software.deployment.create': 'Software deployment created',
  'software.deployment.cancel': 'Software deployment cancelled',
  'software.uninstall.queue': 'Software uninstall queued',
  'patch.approve': 'Patch approved',
  'patch.decline': 'Patch declined',
  'patch.defer': 'Patch deferred',
  'patch.bulk_approve': 'Patches bulk approved',
  'backup.job.run': 'Backup job started',
  'backup.job.cancel': 'Backup job cancelled',
  'discovery.scan.queue': 'Discovery scan queued',
  'admin.device.approve': 'Device approved',
  'admin.device.deny': 'Device denied',
  'monitor.check.queue': 'Monitor check queued',
  'maintenance_occurrence.start': 'Maintenance window started',
  'maintenance_occurrence.end': 'Maintenance window ended',
};

function formatActionMessage(action: string, resourceName: string | null, result: string): string {
  const label = actionLabels[action];
  if (label) {
    const suffix = result === 'failure' ? ' (failed)' : result === 'denied' ? ' (denied)' : '';
    return resourceName ? `${label} — ${resourceName}${suffix}` : `${label}${suffix}`;
  }

  // Fallback: humanize the action string
  const humanized = action
    .replace(/\./g, ' › ')
    .replace(/_/g, ' ');
  const suffix = result === 'failure' ? ' (failed)' : result === 'denied' ? ' (denied)' : '';
  return resourceName ? `${humanized} — ${resourceName}${suffix}` : `${humanized}${suffix}`;
}
