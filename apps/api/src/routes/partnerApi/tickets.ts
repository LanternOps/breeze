import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, eq, getTableColumns, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { ticketComments, tickets } from '../../db/schema';
import { requirePartnerApiScope, type PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import { findTicketIdByExternalRef, ticketExternalRefsFor, type TicketExternalRef } from '../../services/ticketExternalRefs';
import {
  compareXid8,
  createPartnerFeedTokens,
  orgSetHash,
  sha256Hex,
  type PartnerFeedBinding,
} from './feedToken';
import { canonicalJsonStringify, computePartnerExportRevision, safelyExportDefinition } from './exportSafety';
import { normalizePartnerExportLimit, PartnerExportPaginationError } from './pagination';
import {
  partnerExportCursorTokenSchema,
  partnerExportTimestampSchema,
  partnerTicketCommentListSchema,
  partnerTicketFeedEnvelopeSchema,
  partnerTicketIdListSchema,
  partnerTicketRecordResponseSchema,
  PARTNER_TICKET_PRIORITIES,
  PARTNER_TICKET_STATUSES,
  PARTNER_TICKET_TEXT_MAX,
  type PartnerExportBlockedRecord,
  type PartnerTicketCommentExportRecord,
  type PartnerTicketCommentTombstone,
  type PartnerTicketExportRecord,
  type PartnerTicketTombstone,
} from './schemas';

/**
 * Partner API tickets surface, read side (tickets:read).
 *
 *   GET /tickets                — latest-state change feed across the
 *                                 principal's accessible organizations
 *   GET /tickets/ids            — reconciliation list of live ticket ids
 *   GET /tickets/:id            — one ticket
 *   GET /tickets/:id/comments   — the ticket's comments, creation order
 *
 * Change tracking: every write to `tickets` is stamped with its transaction
 * id (`partner_feed_xid`, migrations/2026-12-13-120000), exactly as the
 * alerts feed, and a SECURITY INVOKER trigger on `ticket_comments` restamps
 * the parent for every comment write (new, edited, deleted, from any path).
 * A traversal reads the fixed window [lower, horizon) where `horizon` is the
 * request snapshot's xmin: every transaction below it has committed or
 * aborted, so no committed write can land behind a returned checkpoint. A
 * row rewritten mid-traversal moves above `horizon` and is returned by the
 * NEXT traversal. Several changes of one ticket between polls coalesce into
 * its latest state; delivery is at-least-once across resyncs, so consumers
 * upsert by `id`.
 *
 * Removals: a soft-deleted ticket in an accessible org is delivered as a
 * TOMBSTONE (`removed: true`); a restore delivers the record again. A ticket
 * moved OUT of the principal's org set is not on the feed (its new org is
 * not readable; a tombstone would disclose ids the consumer may never have
 * seen) — `GET /tickets/ids` is how a mirror observes that.
 *
 * Contract for pollers: page with `cursor` until `hasMore` is false, then
 * persist `checkpoint` and pass it as `since` next time. A 409
 * `partner_tickets_resync_required` means start again without `since`.
 * Filters apply to the ticket's CURRENT row. Raw `custom_fields` /
 * `field_provenance` are not exported. `externalTicketId`/`externalTicketUrl`
 * are THIS principal's ref (ticket_external_refs), never another
 * integration's.
 *
 * Reads run inside the partner-scoped RLS context the auth middleware holds
 * for GET requests; the explicit partner/org predicates below are defence in
 * depth, never the isolation boundary.
 */
export const partnerTicketRoutes = new Hono();

export const PARTNER_TICKETS_FEED_HMAC_DOMAIN = 'breeze-partner-tickets-feed-v1';
export const ticketsFeedTokens = createPartnerFeedTokens({
  hmacDomain: PARTNER_TICKETS_FEED_HMAC_DOMAIN,
  tokenErrorCode: 'invalid_partner_tickets_token',
  tokenErrorMessage: 'The partner tickets cursor or checkpoint is invalid or expired.',
  resyncCode: 'partner_tickets_resync_required',
  resyncMessage: 'The tickets checkpoint no longer matches this feed. Start a full sync without `since`.',
});
export const PartnerTicketsFeedTokenError = ticketsFeedTokens.TokenError;
export const PartnerTicketsResyncRequiredError = ticketsFeedTokens.ResyncRequiredError;

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

const feedQuerySchema = z.object({
  orgId: UUID.optional(),
  status: csvEnum(PARTNER_TICKET_STATUSES).optional(),
  priority: csvEnum(PARTNER_TICKET_PRIORITIES).optional(),
  assigneeId: UUID.optional(),
  // Exact match on THIS principal's correlation key (ticket_external_refs).
  externalId: z.string().trim().min(1).max(255).optional(),
  since: partnerExportCursorTokenSchema.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

const idsQuerySchema = z.object({
  orgId: UUID.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

const commentsQuerySchema = z.object({
  // Only comments created strictly after this instant.
  since: partnerExportTimestampSchema.optional(),
  cursor: partnerExportCursorTokenSchema.optional(),
  limit: z.string().optional(),
}).strict();

const idParamSchema = z.object({ id: UUID });

function invalidQuery(c: Context) {
  return c.json({ error: 'Invalid partner tickets query.', code: 'invalid_partner_export_query' }, 400);
}

function notFound(c: Context) {
  return c.json({ error: 'Ticket not found.', code: 'partner_ticket_not_found' }, 404);
}

// Free-text ticket columns are unbounded; the DTO caps them so one oversized
// row can never fail envelope validation (or exceed what the secret scanner
// inspects, PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH) and wedge the feed.
function truncateText(value: string | null, max = PARTNER_TICKET_TEXT_MAX): string | null {
  if (value === null || value.length <= max) return value;
  let cut = max - 1;
  // Never split a surrogate pair: back off if the cut lands after a high surrogate.
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}…`;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PartnerExportPaginationError('Invalid source timestamp.');
  return date.toISOString();
}

const ticketColumns = {
  id: tickets.id,
  orgId: tickets.orgId,
  ticketNumber: tickets.ticketNumber,
  internalNumber: tickets.internalNumber,
  subject: tickets.subject,
  description: tickets.description,
  status: tickets.status,
  statusId: tickets.statusId,
  priority: tickets.priority,
  source: tickets.source,
  workKind: tickets.workKind,
  categoryId: tickets.categoryId,
  assignedTo: tickets.assignedTo,
  deviceId: tickets.deviceId,
  requesterContactId: tickets.requesterContactId,
  submittedBy: tickets.submittedBy,
  submitterName: tickets.submitterName,
  submitterEmail: tickets.submitterEmail,
  tags: tickets.tags,
  dueDate: tickets.dueDate,
  firstResponseAt: tickets.firstResponseAt,
  resolvedAt: tickets.resolvedAt,
  closedAt: tickets.closedAt,
  pendingReason: tickets.pendingReason,
  resolutionNote: tickets.resolutionNote,
  responseSlaMinutes: tickets.responseSlaMinutes,
  resolutionSlaMinutes: tickets.resolutionSlaMinutes,
  slaBreachedAt: tickets.slaBreachedAt,
  slaBreachReason: tickets.slaBreachReason,
  deletedAt: tickets.deletedAt,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
  changeXid: sql<string>`${tickets.partnerFeedXid}::text`,
};

export type TicketRow = {
  [K in keyof typeof ticketColumns]: (typeof ticketColumns)[K] extends { _: { data: infer D } } ? D | null : string;
};

/** A full `tickets` row (e.g. a service return value) as the feed's projected row. */
export function ticketRowFromRecord(row: typeof tickets.$inferSelect): TicketRow {
  return { ...row, changeXid: String(row.partnerFeedXid) } as unknown as TicketRow;
}

/** The public DTO for one live ticket row. Pure: no I/O, no secret inspection. */
export function toPartnerTicketRecord(row: TicketRow, ref: TicketExternalRef | null): PartnerTicketExportRecord {
  const withoutRevision = {
    id: row.id!,
    orgId: row.orgId!,
    ticketNumber: row.ticketNumber!,
    internalNumber: row.internalNumber ?? null,
    subject: row.subject!,
    description: truncateText(row.description ?? null),
    status: row.status!,
    statusId: row.statusId ?? null,
    priority: row.priority!,
    source: row.source!,
    workKind: row.workKind!,
    categoryId: row.categoryId ?? null,
    assigneeId: row.assignedTo ?? null,
    deviceId: row.deviceId ?? null,
    requester: {
      contactId: row.requesterContactId ?? null,
      portalUserId: row.submittedBy ?? null,
      name: row.submitterName ?? null,
      email: row.submitterEmail ?? null,
    },
    tags: (row.tags ?? []).slice(0, 50).map((tag) => tag.slice(0, 100)),
    externalTicketId: ref?.externalId ?? null,
    externalTicketUrl: ref?.externalUrl ?? null,
    dueDate: iso(row.dueDate ?? null),
    firstResponseAt: iso(row.firstResponseAt ?? null),
    resolvedAt: iso(row.resolvedAt ?? null),
    closedAt: iso(row.closedAt ?? null),
    pendingReason: truncateText(row.pendingReason ?? null),
    resolutionNote: truncateText(row.resolutionNote ?? null),
    responseSlaMinutes: row.responseSlaMinutes ?? null,
    resolutionSlaMinutes: row.resolutionSlaMinutes ?? null,
    slaBreachedAt: iso(row.slaBreachedAt ?? null),
    slaBreachReason: truncateText(row.slaBreachReason ?? null, 1000),
    createdAt: iso(row.createdAt ?? null)!,
    updatedAt: iso(row.updatedAt ?? null)!,
    changeVersion: String(row.changeXid),
  };
  return { ...withoutRevision, revision: computePartnerExportRevision(withoutRevision) };
}

function toPartnerTicketTombstone(row: TicketRow): PartnerTicketTombstone {
  return {
    id: row.id!,
    orgId: row.orgId!,
    removed: true,
    reason: 'deleted',
    deletedAt: iso(row.deletedAt ?? null)!,
    changeVersion: String(row.changeXid),
  };
}

type CommentRow = typeof ticketComments.$inferSelect;

export function toPartnerTicketCommentRecord(row: CommentRow, orgId: string): PartnerTicketCommentExportRecord {
  const withoutRevision = {
    id: row.id,
    ticketId: row.ticketId,
    orgId,
    commentType: row.commentType,
    isPublic: row.isPublic,
    authorType: row.authorType ?? null,
    authorName: row.authorName ?? null,
    originPrincipalKind: row.originPrincipalKind as PartnerTicketCommentExportRecord['originPrincipalKind'],
    originPrincipalId: row.originPrincipalId ?? null,
    content: truncateText(row.content) ?? '',
    oldValue: truncateText(row.oldValue ?? null, 2000),
    newValue: truncateText(row.newValue ?? null, 2000),
    createdAt: iso(row.createdAt)!,
    editedAt: iso(row.editedAt ?? null),
  };
  return { ...withoutRevision, revision: computePartnerExportRevision(withoutRevision) };
}

function toPartnerTicketCommentTombstone(row: CommentRow, orgId: string): PartnerTicketCommentTombstone {
  return {
    id: row.id,
    ticketId: row.ticketId,
    orgId,
    removed: true,
    deletedAt: iso(row.deletedAt ?? null)!,
    createdAt: iso(row.createdAt)!,
  };
}

/** Defence-in-depth scope predicate: this principal's partner AND org set. */
function principalScope(principal: PartnerApiPrincipalContext, orgIds: readonly string[]): SQL {
  return and(
    eq(tickets.partnerId, principal.partnerId),
    inArray(tickets.orgId, [...orgIds]),
  )!;
}

/** The live ticket, or null when unknown, foreign, moved out of the set, or soft-deleted. */
export async function getPartnerTicketOr404(principal: PartnerApiPrincipalContext, id: string): Promise<TicketRow | null> {
  if (principal.accessibleOrgIds.length === 0) return null;
  const rows = await db.select(ticketColumns)
    .from(tickets)
    .where(and(eq(tickets.id, id), principalScope(principal, principal.accessibleOrgIds), isNull(tickets.deletedAt)))
    .limit(1);
  return (rows[0] as TicketRow | undefined) ?? null;
}

function handleFeedError(c: Context, error: unknown) {
  if (error instanceof PartnerTicketsResyncRequiredError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof PartnerTicketsFeedTokenError || error instanceof PartnerExportPaginationError) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  return c.json({ error: 'Partner tickets export failed.', code: 'partner_export_failed' }, 500);
}

partnerTicketRoutes.get('/tickets', requirePartnerApiScope('tickets:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = feedQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return invalidQuery(c);
  const query = parsed.data;
  if (query.since && query.cursor) return invalidQuery(c);
  if (query.orgId && !principal.accessibleOrgIds.includes(query.orgId)) {
    return c.json({ error: 'Organization not found.', code: 'partner_export_org_not_found' }, 404);
  }

  try {
    const limit = normalizePartnerExportLimit(query.limit);
    const orgIds = query.orgId ? [query.orgId] : [...principal.accessibleOrgIds];
    const [snapshot] = await db.execute<{ horizon: string; xmax: string; epoch: string }>(sql`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS "horizon",
             pg_snapshot_xmax(pg_current_snapshot())::text AS "xmax",
             (SELECT system_identifier::text FROM pg_control_system())
               || ':' || (SELECT timeline_id::text FROM pg_control_checkpoint())
               || ':' || (SELECT oid::text FROM pg_database WHERE datname = current_database())
               || ':' || ('public.tickets'::regclass)::oid::text AS "epoch"
    `);
    if (!snapshot) throw new Error('Partner tickets feed snapshot unavailable.');
    const binding: PartnerFeedBinding = {
      partnerId: principal.partnerId,
      epoch: snapshot.epoch,
      filtersHash: sha256Hex(canonicalJsonStringify({
        orgId: query.orgId ?? null,
        status: query.status ?? null,
        priority: query.priority ?? null,
        assigneeId: query.assigneeId ?? null,
        externalId: query.externalId ?? null,
      })),
      orgSetHash: orgSetHash(orgIds),
    };

    let lower: string | null;
    let horizon: string;
    let after: { xid: string; id: string } | null = null;
    if (query.cursor) {
      const page = ticketsFeedTokens.decodePageToken(query.cursor, binding);
      lower = page.lower;
      horizon = page.horizon;
      after = { xid: page.lastXid, id: page.lastId };
    } else {
      horizon = snapshot.horizon;
      lower = null;
      if (query.since) {
        const checkpoint = ticketsFeedTokens.decodeCheckpointToken(query.since, binding);
        // A checkpoint beyond this database's current xid range means the
        // database was restored or replaced: its positions are meaningless.
        if (compareXid8(checkpoint.horizon, snapshot.xmax) > 0) throw new PartnerTicketsResyncRequiredError();
        lower = checkpoint.horizon;
        // The horizon cannot normally move backwards; if it ever does, return
        // no rows and hand the same checkpoint back rather than re-reading.
        if (compareXid8(lower, horizon) > 0) horizon = lower;
      }
    }

    const conditions: SQL[] = [
      principalScope(principal, orgIds),
      sql`${tickets.partnerFeedXid} < ${horizon}::xid8`,
    ];
    if (lower !== null) conditions.push(sql`${tickets.partnerFeedXid} >= ${lower}::xid8`);
    if (after) conditions.push(sql`(${tickets.partnerFeedXid}, ${tickets.id}) > (${after.xid}::xid8, ${after.id}::uuid)`);
    if (query.status) conditions.push(inArray(tickets.status, query.status));
    if (query.priority) conditions.push(inArray(tickets.priority, query.priority));
    if (query.assigneeId) conditions.push(eq(tickets.assignedTo, query.assigneeId));
    let externalIdMiss = false;
    if (query.externalId) {
      const ticketId = await findTicketIdByExternalRef(principal.partnerServicePrincipalId, query.externalId);
      if (ticketId) conditions.push(eq(tickets.id, ticketId));
      else externalIdMiss = true;
    }

    const rows = orgIds.length === 0 || externalIdMiss ? [] : await db.select(ticketColumns)
      .from(tickets)
      .where(and(...conditions))
      .orderBy(asc(tickets.partnerFeedXid), asc(tickets.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit) as TicketRow[];
    const refs = await ticketExternalRefsFor(
      principal.partnerServicePrincipalId,
      pageRows.filter((row) => !row.deletedAt).map((row) => row.id!),
    );
    const data: Array<PartnerTicketExportRecord | PartnerTicketTombstone> = [];
    const blocked: PartnerExportBlockedRecord[] = [];
    for (const row of pageRows) {
      if (row.deletedAt) {
        data.push(toPartnerTicketTombstone(row));
        continue;
      }
      const record = toPartnerTicketRecord(row, refs.get(row.id!) ?? null);
      const inspected = safelyExportDefinition({ resource: 'tickets' as const, id: record.id, orgId: record.orgId }, record);
      if (inspected.safe) data.push(inspected.definition);
      else blocked.push(inspected.blocked);
    }

    const last = pageRows.at(-1);
    const envelope = {
      schemaVersion: '1' as const,
      mode: lower === null ? 'full' as const : 'incremental' as const,
      data,
      nextCursor: hasMore && last
        ? ticketsFeedTokens.encodePageToken({ ...binding, lower, horizon, lastXid: String(last.changeXid), lastId: last.id! })
        : null,
      hasMore,
      checkpoint: hasMore ? null : ticketsFeedTokens.encodeCheckpointToken({ ...binding, horizon }),
      ...(blocked.length > 0 ? { blocked } : {}),
    };
    return c.json(partnerTicketFeedEnvelopeSchema.parse(envelope));
  } catch (error) {
    return handleFeedError(c, error);
  }
});

// Registered BEFORE `/tickets/:id` so the literal segment is not captured as an id.
partnerTicketRoutes.get('/tickets/ids', requirePartnerApiScope('tickets:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = idsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return invalidQuery(c);
  const query = parsed.data;
  if (query.orgId && !principal.accessibleOrgIds.includes(query.orgId)) {
    return c.json({ error: 'Organization not found.', code: 'partner_export_org_not_found' }, 404);
  }
  try {
    const limit = normalizePartnerExportLimit(query.limit);
    const orgIds = query.orgId ? [query.orgId] : [...principal.accessibleOrgIds];
    const keysetBinding = {
      partnerId: principal.partnerId,
      scopeHash: sha256Hex(canonicalJsonStringify({ list: 'ticket-ids', orgId: query.orgId ?? null, orgSet: orgSetHash(orgIds) })),
    };
    const conditions: SQL[] = [principalScope(principal, orgIds), isNull(tickets.deletedAt)];
    if (query.cursor) {
      const keyset = ticketsFeedTokens.decodeKeysetToken(query.cursor, keysetBinding);
      conditions.push(gt(tickets.id, keyset.lastId));
    }
    const rows = orgIds.length === 0 ? [] : await db
      .select({ id: tickets.id, orgId: tickets.orgId, changeXid: sql<string>`${tickets.partnerFeedXid}::text` })
      .from(tickets)
      .where(and(...conditions))
      .orderBy(asc(tickets.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return c.json(partnerTicketIdListSchema.parse({
      schemaVersion: '1',
      data: pageRows.map((row) => ({ id: row.id, orgId: row.orgId, changeVersion: String(row.changeXid) })),
      nextCursor: hasMore && last
        ? ticketsFeedTokens.encodeKeysetToken({ ...keysetBinding, lastKey: last.id, lastId: last.id })
        : null,
      hasMore,
    }));
  } catch (error) {
    return handleFeedError(c, error);
  }
});

partnerTicketRoutes.get('/tickets/:id', requirePartnerApiScope('tickets:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const params = idParamSchema.safeParse({ id: c.req.param('id') });
  if (!params.success) return notFound(c);
  try {
    const row = await getPartnerTicketOr404(principal, params.data.id);
    if (!row) return notFound(c);
    const refs = await ticketExternalRefsFor(principal.partnerServicePrincipalId, [row.id!]);
    const record = toPartnerTicketRecord(row, refs.get(row.id!) ?? null);
    const inspected = safelyExportDefinition({ resource: 'tickets' as const, id: record.id, orgId: record.orgId }, record);
    if (!inspected.safe) {
      return c.json({
        error: 'Ticket withheld: a field looks like a credential.',
        code: 'partner_export_record_blocked',
        blocked: inspected.blocked,
      }, 422);
    }
    return c.json(partnerTicketRecordResponseSchema.parse({ schemaVersion: '1', data: inspected.definition }));
  } catch (error) {
    return handleFeedError(c, error);
  }
});

partnerTicketRoutes.get('/tickets/:id/comments', requirePartnerApiScope('tickets:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const params = idParamSchema.safeParse({ id: c.req.param('id') });
  if (!params.success) return notFound(c);
  const parsed = commentsQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return invalidQuery(c);
  const query = parsed.data;
  try {
    const limit = normalizePartnerExportLimit(query.limit);
    // Authorization first: an unknown or foreign ticket is a 404 before any
    // cursor is examined, so a token cannot probe for existence.
    const ticket = await getPartnerTicketOr404(principal, params.data.id);
    if (!ticket) return notFound(c);
    const ticketId = ticket.id!;
    const orgId = ticket.orgId!;

    const since = query.since ? new Date(query.since).toISOString() : null;
    const keysetBinding = {
      partnerId: principal.partnerId,
      scopeHash: sha256Hex(canonicalJsonStringify({ ticketId, since })),
    };
    // Deleted comments are INCLUDED (as tombstones) so a mirror observes deletes.
    const conditions: SQL[] = [eq(ticketComments.ticketId, ticketId)];
    if (since) conditions.push(gt(ticketComments.createdAt, new Date(since)));
    if (query.cursor) {
      const keyset = ticketsFeedTokens.decodeKeysetToken(query.cursor, keysetBinding);
      // Row comparison on the exact stored value: `lastKey` is the previous
      // page's `created_at::text` (microsecond precision), never a JS Date.
      conditions.push(sql`(${ticketComments.createdAt}, ${ticketComments.id}) > (${keyset.lastKey}::timestamp, ${keyset.lastId}::uuid)`);
    }

    const rows = await db.select({
      ...getTableColumns(ticketComments),
      createdAtKey: sql<string>`${ticketComments.createdAt}::text`,
    })
      .from(ticketComments)
      .where(and(...conditions))
      .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const data: Array<PartnerTicketCommentExportRecord | PartnerTicketCommentTombstone> = [];
    const blocked: PartnerExportBlockedRecord[] = [];
    for (const row of pageRows) {
      if (row.deletedAt) {
        data.push(toPartnerTicketCommentTombstone(row, orgId));
        continue;
      }
      const record = toPartnerTicketCommentRecord(row, orgId);
      // Inspected under the parent resource: a blocked entry names the comment id.
      const inspected = safelyExportDefinition({ resource: 'tickets' as const, id: record.id, orgId }, record);
      if (inspected.safe) data.push(inspected.definition);
      else blocked.push(inspected.blocked);
    }

    const last = pageRows.at(-1);
    const body = {
      schemaVersion: '1' as const,
      ticketId,
      data,
      nextCursor: hasMore && last
        ? ticketsFeedTokens.encodeKeysetToken({ ...keysetBinding, lastKey: last.createdAtKey ?? iso(last.createdAt)!, lastId: last.id })
        : null,
      hasMore,
      ...(blocked.length > 0 ? { blocked } : {}),
    };
    return c.json(partnerTicketCommentListSchema.parse(body));
  } catch (error) {
    return handleFeedError(c, error);
  }
});
