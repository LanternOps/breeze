import { Hono } from 'hono';
import { AUDIT_RESULTS } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
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

// Build the OR-group of action conditions for the deliberate-action filter:
// each supplied action prefix, plus (opt-in) automated agent-dispatched
// commands. Exported so the includeAutomated dedup can be exercised against a
// live Postgres (the actor_type guard is a LIKE/IN predicate a Drizzle mock
// can't prove). Returns the disjuncts; the caller OR-combines them.
export function buildActionConditions(
  actions: string[] | undefined,
  includeAutomated: boolean
): SQL[] {
  const actionClauses: SQL[] = [];
  if (actions && actions.length > 0) {
    // `LIKE` with an escaped prefix keeps it index-friendly and avoids ILIKE's
    // case-fold cost — audit action keys are already lowercase dotted ids.
    for (const prefix of actions) {
      actionClauses.push(sql`${auditLogs.action} LIKE ${likePrefixPattern(prefix)}`);
    }
  }
  if (includeAutomated) {
    // Automated patch runs / automations are written by commandQueue as
    // `agent.command.<type>` with actor_type 'system' (commandQueue emits
    // 'system' for any unattended dispatch, never a real user) and have no
    // route-audit twin. Manual commands (actor_type 'user') are excluded —
    // they're already represented by their richer route audit (e.g.
    // script.execute, device.patch.*, device.software.*), so this avoids
    // double-listing. 'agent' is excluded too: the device agent's own
    // `agent.command.result.submit` rows are telemetry (resource = the command,
    // actor = the agent), and the deliberate feed adds `actor_type <> 'agent'`
    // at the top level so its partial index applies — see the feed predicate
    // comment in the route below.
    actionClauses.push(
      sql`(${auditLogs.action} LIKE ${likePrefixPattern('agent.command.')} AND ${auditLogs.actorType} = 'system')`
    );
  }
  return actionClauses;
}

// Excludes device-agent telemetry (agent.logs.submit, agent.sessions.submit,
// ...), which is ~99% of audit_logs. Written as an inline literal on purpose: the
// partial indexes in 2026-10-09-000100-audit-logs-device-feed-partial-indexes.sql
// carry this exact predicate, and the planner can only prove them usable when
// the clause is a constant in the query text (a bound parameter would only be
// provable under a custom plan).
export const NON_AGENT_ACTOR: SQL = sql`${auditLogs.actorType} <> 'agent'`;

// The audit_logs_device_feed_details_idx predicate. Implied by the
// `details->>'deviceId' = X` test the details arm also applies, but the planner
// cannot derive one from the other, so it is stated explicitly.
export const DETAILS_HAS_DEVICE_ID: SQL = sql`${auditLogs.details} ? 'deviceId'`;

// Microsecond-precision sort key selected alongside each row. audit_logs.timestamp
// has microsecond precision and each arm is ordered by it in SQL, but Drizzle
// hands it back as a JS Date (milliseconds). Merging on the Date would order two
// rows from different arms that fall in the same millisecond differently from
// SQL, and a page boundary between them would then skip or repeat a row. The
// fixed-width text key sorts exactly like the column.
export const FEED_SORT_KEY: SQL<string> = sql<string>`to_char(${auditLogs.timestamp}, 'YYYYMMDDHH24MISSUS')`;

// Merge the two feed arms (each already ordered timestamp DESC, id DESC in SQL
// and bounded to offset+limit rows) and cut the requested page. Exact for any
// offset because the top-(offset+limit) of the union is contained in the union
// of each arm's top-(offset+limit) — provided the merge order is IDENTICAL to
// the SQL order, hence the microsecond `sortKey` (FEED_SORT_KEY) rather than the
// millisecond Date, and the same id DESC tiebreak (uuid text order == uuid
// byte order for canonical lowercase uuids).
export function mergeFeedPage<T extends { sortKey: string; id: string }>(
  resourceRows: T[],
  detailsRows: T[],
  offset: number,
  limit: number
): T[] {
  const desc = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
  const merged =
    detailsRows.length === 0
      ? resourceRows
      : resourceRows.length === 0
        ? detailsRows
        : [...resourceRows, ...detailsRows].sort(
            (a, b) => desc(a.sortKey, b.sortKey) || desc(a.id, b.id)
          );
  return merged.slice(offset, offset + limit);
}

const eventsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: eventCategoryEnum.optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
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
  // Opt-in to also surface automated agent.command.* commands.
  includeAutomated: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
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
    const { search, category, result, initiatedBy, from, to, page, limit, actions, withTotal, includeAutomated } =
      c.req.valid('query');
    const offset = (page - 1) * limit;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // ---- Feed predicate ---------------------------------------------------
    //
    // The feed runs as breeze_app with RLS forced on audit_logs. Under a
    // security qual Postgres only promotes a clause to an INDEX CONDITION when
    // it is leakproof; everything else is evaluated after the policy, as a
    // plain filter. That rules out most of this predicate: `details->>'deviceId'`
    // (jsonb_object_field_text), `action LIKE ...` (textlike) and
    // `actor_type IN (...)` (enum_eq) are all non-leakproof, and an OR that
    // contains one of them is non-leakproof as a whole. Only `org_id = X` and
    // `resource_id = X` (uuid_eq) can drive an index.
    //
    // The original single query, `(resource_id = X OR details->>'deviceId' = X)`,
    // therefore had exactly one index path: audit_logs_org_timestamp_idx, i.e.
    // the org's ENTIRE audit history filtered row by row. On the largest US org
    // (2.4M rows, 99% agent telemetry) that was 90 s mean and 13+ minutes worst
    // case per device page load, and it saturated the managed DB (2026-09-03).
    //
    // So the feed is two arms, merged in mergeFeedPage():
    //
    //   1. resource arm — `resource_id = device` as a TOP-LEVEL clause, so it is
    //      an index condition. When the caller asks for the deliberate-action
    //      feed (`actions` / `includeAutomated`), `actor_type <> 'agent'` is
    //      added too: those action families are written by route handlers and
    //      commandQueue, never by the device agent, so the clause changes
    //      nothing semantically — but it lets the planner prove the partial
    //      index audit_logs_device_feed_resource_idx (predicate proof is
    //      static, leakproofness is irrelevant there) and skip the ~99% of the
    //      device's rows that are telemetry. The unfiltered Activities tab keeps
    //      the agent rows and uses audit_logs_resource_id_timestamp_idx.
    //   2. details arm — rows that reference the device only through
    //      details.deviceId (device.command.queue, remote sessions). Their
    //      resource is something else, so this arm is keyed on the org via
    //      audit_logs_device_feed_details_idx, a partial index on
    //      `details ? 'deviceId'`. That predicate is stated verbatim here so
    //      the proof holds (the `->>` equality cannot be derived from it). Rows
    //      carrying the key are rare for every actor type (51 in the largest
    //      US org), so the JSONB equality runs as a filter over a few rows
    //      instead of the org's whole history — and the arm keeps the old OR's
    //      semantics exactly; no actor is excluded from it except, for the
    //      deliberate feed, the same telemetry exclusion as arm 1.
    //      `resource_id IS DISTINCT FROM device` keeps the arms disjoint so the
    //      merged page and the summed count have no duplicates.
    //
    // Both arms keep `org_id = device.orgId` (BREEZE-B). It is a leakproof
    // index-able clause and the visibility semantics are intended: the device's
    // feed shows only its own org. breeze_has_org_access(NULL) is FALSE, so rows
    // written with a null org_id were already invisible to org/partner callers.
    //
    // Migration: 2026-10-09-000100-audit-logs-device-feed-partial-indexes.sql.
    // Contract test (real Postgres, as breeze_app):
    // __tests__/integration/deviceEventsFeedIndexes.integration.test.ts.
    const commonConditions: SQL[] = [eq(auditLogs.orgId, device.orgId)];

    if (search) {
      const term = `%${search}%`;
      commonConditions.push(
        or(
          ilike(auditLogs.action, term),
          ilike(auditLogs.resourceName, term),
          sql`${auditLogs.details}::text ILIKE ${term}`
        )!
      );
    }

    if (category) {
      // Filter by action prefix category
      commonConditions.push(ilike(auditLogs.action, `${category}.%`));
    }

    // The overview "deliberate action" filter: any supplied action prefix, plus
    // (opt-in) automated agent-dispatched commands. Both go into one OR group.
    const actionClauses = buildActionConditions(actions, includeAutomated);
    const deliberateFeed = actionClauses.length > 0;
    if (deliberateFeed) {
      commonConditions.push(or(...actionClauses)!);
    }

    if (result) {
      commonConditions.push(eq(auditLogs.result, result));
    }

    if (initiatedBy) {
      commonConditions.push(eq(auditLogs.initiatedBy, initiatedBy));
    }

    if (from) {
      commonConditions.push(gte(auditLogs.timestamp, from));
    }
    if (to) {
      commonConditions.push(lte(auditLogs.timestamp, to));
    }

    const resourceArm = and(
      ...commonConditions,
      eq(auditLogs.resourceId, deviceId),
      ...(deliberateFeed ? [NON_AGENT_ACTOR] : [])
    )!;
    const detailsArm = and(
      ...commonConditions,
      ...(deliberateFeed ? [NON_AGENT_ACTOR] : []),
      DETAILS_HAS_DEVICE_ID,
      sql`${auditLogs.details}->>'deviceId' = ${deviceId}`,
      sql`${auditLogs.resourceId} IS DISTINCT FROM ${deviceId}::uuid`
    )!;

    // Each arm is a bounded "top offset+limit" read in index order; the page is
    // cut from the merged result (mergeFeedPage), which is exact because the
    // union's top-N is contained in the union of each arm's top-N.
    const fetchLimit = offset + limit;
    const selectArm = (where: SQL) =>
      db
        .select({
          id: auditLogs.id,
          timestamp: auditLogs.timestamp,
          sortKey: FEED_SORT_KEY,
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
        .where(where)
        .orderBy(desc(auditLogs.timestamp), desc(auditLogs.id))
        .limit(fetchLimit);

    // The total is an unbounded count(*) over the device's whole audit history;
    // only run it when the caller actually renders a total (issue #1726).
    const countArm = (where: SQL) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where)
        .then((r) => Number(r[0]?.count ?? 0));

    const [resourceRows, detailsRows, resourceCount, detailsCount] = await Promise.all([
      selectArm(resourceArm),
      selectArm(detailsArm),
      withTotal ? countArm(resourceArm) : Promise.resolve(null),
      withTotal ? countArm(detailsArm) : Promise.resolve(null),
    ]);

    const rows = mergeFeedPage(resourceRows, detailsRows, offset, limit);
    const total =
      resourceCount === null || detailsCount === null ? null : resourceCount + detailsCount;

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

export function resolveActorLabel(actorType: string, actorId: string): string {
  if (actorType === 'agent') return 'Agent';
  if (actorType === 'ai_agent') {
    // Autonomous AI-agent principal (wave 3, #3824), distinct from 'agent'
    // (the Go device agent).
    return 'AI Agent';
  }
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
  'device.recovery_key.reveal': 'Recovery key revealed',
  'device.recovery_key.rotate': 'Recovery key rotation requested',
  'agent.recovery_keys.submit': 'Recovery keys escrowed',
  'script.execute': 'Script executed',
  'script.execution.cancel': 'Script execution cancelled',
  // These fire when the command is DISPATCHED to the agent, not when it
  // completes — the audit row's `result` is 'dispatched', not 'success' (see
  // commandQueue.ts, #4225). Keep the copy in the command-sent tense so it
  // doesn't assert an outcome the row can't know yet.
  'agent.command.install_patches': 'Patch install command sent',
  'agent.command.rollback_patches': 'Patch rollback command sent',
  'agent.command.script': 'Script run command sent',
  'agent.command.software_uninstall': 'Software uninstall command sent',
  'agent.command.software_update': 'Software update command sent',
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

export function formatActionMessage(action: string, resourceName: string | null, result: string): string {
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
