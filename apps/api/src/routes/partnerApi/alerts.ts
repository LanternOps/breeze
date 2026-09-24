import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { alertRules, alerts, devices, monitorDefinitions, monitorEpisodes } from '../../db/schema';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import {
  compareXid8,
  decodeCheckpointToken,
  decodePageToken,
  encodeCheckpointToken,
  encodePageToken,
  orgSetHash,
  PartnerAlertsFeedTokenError,
  PartnerAlertsResyncRequiredError,
  sha256Hex,
  type PartnerAlertsFeedBinding,
} from './alertsFeedToken';
import { canonicalJsonStringify, computePartnerExportRevision, safelyExportDefinition } from './exportSafety';
import { normalizePartnerExportLimit, PartnerExportPaginationError } from './pagination';
import {
  partnerAlertFeedEnvelopeSchema,
  partnerExportCursorTokenSchema,
  partnerExportTimestampSchema,
  PARTNER_ALERT_SEVERITIES,
  PARTNER_ALERT_STATUSES,
  type PartnerAlertExportRecord,
  type PartnerExportBlockedRecord,
} from './schemas';

/**
 * GET /api/v1/partner-api/alerts (alerts:read) — read-only, latest-state
 * alert feed across the principal's accessible organizations.
 *
 * Change tracking: every write to `alerts` is stamped with its transaction id
 * (`partner_feed_xid`, see migrations/2026-10-30-100000). A traversal reads
 * the fixed window [lower, horizon) where `horizon` is the request snapshot's
 * xmin: every transaction below it has committed or aborted, so no committed
 * write can land behind a returned checkpoint. A row rewritten mid-traversal
 * moves above `horizon` and is returned by the NEXT traversal. Several
 * transitions of one alert between polls coalesce into its latest state.
 *
 * Contract for pollers: page with `cursor` until `hasMore` is false, then
 * persist `checkpoint` and pass it as `since` next time. A 409
 * `partner_alerts_resync_required` means start again without `since`.
 * Filters apply to the alert's CURRENT row: a filtered feed does not report
 * an alert leaving the filter (e.g. `status=active` never shows it resolving).
 * Deleted alerts are not reported. Raw `context` is not exported.
 */
export const partnerAlertRoutes = new Hono();

const UUID = z.string().uuid();
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().max(200).transform((raw, ctx) => {
    const items = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))].sort();
    if (items.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty list' });
      return z.NEVER;
    }
    for (const item of items) {
      if (!(values as readonly string[]).includes(item)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unsupported value' });
        return z.NEVER;
      }
    }
    return items as T[number][];
  });

const querySchema = z.object({
  orgId: UUID.optional(),
  status: csvEnum(PARTNER_ALERT_STATUSES).optional(),
  severity: csvEnum(PARTNER_ALERT_SEVERITIES).optional(),
  triggeredSince: partnerExportTimestampSchema.optional(),
  since: partnerExportCursorTokenSchema.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

function invalidQuery(c: Context) {
  return c.json({ error: 'Invalid partner alerts query.', code: 'invalid_partner_export_query' }, 400);
}

// alerts.message is unbounded text; the DTO caps it so one oversized row can
// never fail envelope validation (or exceed what the secret scanner will
// inspect, PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH) and wedge the feed.
export const PARTNER_ALERT_MESSAGE_MAX = 12_000;
function truncateMessage(message: string | null): string | null {
  if (message === null || message.length <= PARTNER_ALERT_MESSAGE_MAX) return message;
  let cut = PARTNER_ALERT_MESSAGE_MAX - 1;
  // Never split a surrogate pair: back off if the cut lands after a high surrogate.
  const last = message.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${message.slice(0, cut)}…`;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PartnerExportPaginationError('Invalid source timestamp.');
  return date.toISOString();
}

partnerAlertRoutes.get('/alerts', requirePartnerApiScope('alerts:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return invalidQuery(c);
  const query = parsed.data;
  if (query.since && query.cursor) return invalidQuery(c);
  if (query.orgId && !principal.accessibleOrgIds.includes(query.orgId)) {
    return c.json({ error: 'Organization not found.', code: 'partner_export_org_not_found' }, 404);
  }

  try {
    const limit = normalizePartnerExportLimit(query.limit);
    const orgIds = query.orgId ? [query.orgId] : [...principal.accessibleOrgIds];
    const triggeredSince = query.triggeredSince ? new Date(query.triggeredSince).toISOString() : null;
    const [snapshot] = await db.execute<{ horizon: string; xmax: string; epoch: string }>(sql`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS "horizon",
             pg_snapshot_xmax(pg_current_snapshot())::text AS "xmax",
             (SELECT system_identifier::text FROM pg_control_system())
               || ':' || (SELECT timeline_id::text FROM pg_control_checkpoint())
               || ':' || (SELECT oid::text FROM pg_database WHERE datname = current_database())
               || ':' || ('public.alerts'::regclass)::oid::text AS "epoch"
    `);
    if (!snapshot) throw new Error('Partner alerts feed snapshot unavailable.');
    const binding: PartnerAlertsFeedBinding = {
      partnerId: principal.partnerId,
      epoch: snapshot.epoch,
      filtersHash: sha256Hex(canonicalJsonStringify({
        orgId: query.orgId ?? null,
        status: query.status ?? null,
        severity: query.severity ?? null,
        triggeredSince,
      })),
      orgSetHash: orgSetHash(orgIds),
    };

    let lower: string | null;
    let horizon: string;
    let after: { xid: string; id: string } | null = null;
    if (query.cursor) {
      const page = decodePageToken(query.cursor, binding);
      lower = page.lower;
      horizon = page.horizon;
      after = { xid: page.lastXid, id: page.lastId };
    } else {
      horizon = snapshot.horizon;
      lower = null;
      if (query.since) {
        const checkpoint = decodeCheckpointToken(query.since, binding);
        // A checkpoint beyond this database's current xid range means the
        // database was restored or replaced: its positions are meaningless.
        if (compareXid8(checkpoint.horizon, snapshot.xmax) > 0) throw new PartnerAlertsResyncRequiredError();
        lower = checkpoint.horizon;
        // The horizon cannot normally move backwards; if it ever does, return
        // no rows and hand the same checkpoint back rather than re-reading.
        if (compareXid8(lower, horizon) > 0) horizon = lower;
      }
    }

    const conditions: SQL[] = [
      inArray(alerts.orgId, orgIds),
      sql`${alerts.partnerFeedXid} < ${horizon}::xid8`,
    ];
    if (lower !== null) conditions.push(sql`${alerts.partnerFeedXid} >= ${lower}::xid8`);
    if (after) conditions.push(sql`(${alerts.partnerFeedXid}, ${alerts.id}) > (${after.xid}::xid8, ${after.id}::uuid)`);
    if (query.status) conditions.push(inArray(alerts.status, query.status));
    if (query.severity) conditions.push(inArray(alerts.severity, query.severity));
    if (triggeredSince) conditions.push(gt(alerts.triggeredAt, new Date(triggeredSince)));

    const rows = orgIds.length === 0 ? [] : await db.select({
      id: alerts.id,
      orgId: alerts.orgId,
      // devices joined on id AND org: an alert whose device_id points at a
      // device in another org (alerts has no composite device/org FK) must
      // never disclose that device, so both come back null.
      deviceId: devices.id,
      deviceHostname: devices.hostname,
      severity: alerts.severity,
      status: alerts.status,
      title: alerts.title,
      message: alerts.message,
      triggeredAt: alerts.triggeredAt,
      acknowledgedAt: alerts.acknowledgedAt,
      resolvedAt: alerts.resolvedAt,
      dismissedAt: alerts.dismissedAt,
      suppressedUntil: alerts.suppressedUntil,
      requiresHuman: alerts.requiresHuman,
      // Same rule as deviceId: alerts carries only existence FKs for these, so
      // each id is emitted only when the referenced row belongs to the alert's
      // org (or, for partner-wide rules/monitors, to this principal's partner).
      episodeId: monitorEpisodes.id,
      ruleId: alertRules.id,
      monitorId: monitorDefinitions.id,
      changeXid: sql<string>`${alerts.partnerFeedXid}::text`,
    }).from(alerts)
      .leftJoin(devices, and(eq(devices.id, alerts.deviceId), eq(devices.orgId, alerts.orgId)))
      .leftJoin(alertRules, and(eq(alertRules.id, alerts.ruleId), or(
        eq(alertRules.orgId, alerts.orgId),
        and(isNull(alertRules.orgId), eq(alertRules.partnerId, principal.partnerId)),
      )))
      .leftJoin(monitorDefinitions, and(eq(monitorDefinitions.id, alerts.monitorId), or(
        eq(monitorDefinitions.orgId, alerts.orgId),
        and(isNull(monitorDefinitions.orgId), eq(monitorDefinitions.partnerId, principal.partnerId)),
      )))
      .leftJoin(monitorEpisodes, and(eq(monitorEpisodes.id, alerts.episodeId), eq(monitorEpisodes.orgId, alerts.orgId)))
      .where(and(...conditions))
      .orderBy(asc(alerts.partnerFeedXid), asc(alerts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const data: PartnerAlertExportRecord[] = [];
    const blocked: PartnerExportBlockedRecord[] = [];
    for (const row of pageRows) {
      const withoutRevision = {
        id: row.id,
        orgId: row.orgId,
        deviceId: row.deviceId ?? null,
        deviceHostname: row.deviceHostname ?? null,
        severity: row.severity,
        status: row.status,
        title: row.title,
        message: truncateMessage(row.message),
        triggeredAt: iso(row.triggeredAt)!,
        acknowledgedAt: iso(row.acknowledgedAt),
        resolvedAt: iso(row.resolvedAt),
        dismissedAt: iso(row.dismissedAt),
        suppressedUntil: iso(row.suppressedUntil),
        requiresHuman: row.requiresHuman,
        episodeId: row.episodeId ?? null,
        ruleId: row.ruleId ?? null,
        monitorId: row.monitorId ?? null,
        changeVersion: String(row.changeXid),
      };
      // revision covers the alert's own state only; the hostname is read-time
      // enrichment that never advances the feed, so it must not move revision.
      const { deviceHostname: _enrichment, ...revisionBasis } = withoutRevision;
      const record = { ...withoutRevision, revision: computePartnerExportRevision(revisionBasis) };
      const inspected = safelyExportDefinition({ resource: 'alerts', id: row.id, orgId: row.orgId }, record);
      if (inspected.safe) data.push(inspected.definition);
      else blocked.push(inspected.blocked);
    }

    const last = pageRows.at(-1);
    const envelope = {
      schemaVersion: '1' as const,
      mode: lower === null ? 'full' as const : 'incremental' as const,
      data,
      nextCursor: hasMore && last
        ? encodePageToken({ ...binding, lower, horizon, lastXid: String(last.changeXid), lastId: last.id })
        : null,
      hasMore,
      checkpoint: hasMore ? null : encodeCheckpointToken({ ...binding, horizon }),
      ...(blocked.length > 0 ? { blocked } : {}),
    };
    return c.json(partnerAlertFeedEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (error instanceof PartnerAlertsResyncRequiredError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    if (error instanceof PartnerAlertsFeedTokenError || error instanceof PartnerExportPaginationError) {
      return c.json({ error: error.message, code: error.code }, 400);
    }
    return c.json({ error: 'Partner alerts export failed.', code: 'partner_export_failed' }, 500);
  }
});
