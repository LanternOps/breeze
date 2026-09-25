/**
 * Query + serialization for GET /pam/elevation-audit/export — server-side
 * export of the PAM `elevation_audit` event ledger (#4910).
 *
 * One row per ledger event, ascending (occurred_at, id), CSV or JSONL, paged
 * by an opaque keyset cursor the caller follows until `X-Next-Cursor` is empty.
 * Paged rather than streamed: a streamed body would outlive the request's
 * RLS transaction (authMiddleware → withDbAccessContext awaits the handler,
 * not the body), and every page here re-runs the caller's authorization.
 *
 * What this is NOT: tamper evidence. `elevation_audit` is append-only by
 * convention only (UPDATE/DELETE policies exist, the request FK cascades), so
 * an export can show what the ledger holds now, not that it was never edited.
 * Request columns are the request's CURRENT state, not its state at the
 * event's time.
 */
import { SQL, and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { csvRow } from './spreadsheetExport';
import { db } from '../db';
import { elevationAudit, elevationRequests } from '../db/schema';

/** Bumped whenever the column set or a column's meaning changes. */
export const PAM_AUDIT_EXPORT_SCHEMA_VERSION = 1;
export const PAM_AUDIT_EXPORT_MAX_LIMIT = 1000;
export const PAM_AUDIT_EXPORT_MAX_WINDOW_DAYS = 366;

/**
 * `details` is an open jsonb container (excludedOpen in the tenant-export
 * policy), so it is never exported raw. Only these reviewed, scalar keys —
 * the ones PAM's own writers set — pass through; anything else is dropped.
 */
export const PAM_AUDIT_DETAIL_ALLOWLIST = [
  'reason',
  'duration_minutes',
  'cause',
  'prior_status',
  'outcome',
  'actualStatus',
  'timeoutMs',
  'ingest_status',
  'tool_name',
  'risk_tier',
  'execution_id',
  'pam_rule_id',
  'pam_rule_name',
  'source',
  'approval_request_id',
  'triggerSource',
] as const;

export const PAM_AUDIT_EXPORT_COLUMNS = [
  'id',
  'org_id',
  'elevation_request_id',
  'event_type',
  'actor',
  'actor_user_id',
  'occurred_at',
  'created_at',
  'details',
  'request_device_id',
  'request_site_id',
  'request_flow_type',
  'request_subject_user_id',
  'request_subject_username',
  'request_reason',
  'request_target_executable_path',
  'request_target_executable_hash',
  'request_target_executable_signer',
  'request_target_publisher',
  'request_status',
  'request_revision',
  'request_requested_at',
  'request_approved_at',
  'request_approved_by_user_id',
  'request_denied_by_user_id',
  'request_denial_reason',
  'request_expires_at',
  'request_revoked_at',
  'request_revoked_by_user_id',
  'request_revoked_reason',
  'request_execution_id',
  'request_tool_name',
  'request_action_digest',
  'request_risk_tier',
  'request_decided_assurance_level',
  'request_decided_via',
] as const;

type ExportColumn = (typeof PAM_AUDIT_EXPORT_COLUMNS)[number];
export type ExportRecord = Record<ExportColumn, string | number | Record<string, unknown> | null>;

export function projectAuditDetails(details: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!details || typeof details !== 'object' || Array.isArray(details)) return out;
  const source = details as Record<string, unknown>;
  for (const key of PAM_AUDIT_DETAIL_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

// Cursor: base64url of `<occurred_at as Postgres text>|<id>`. It carries no
// authority — filters and scope come from the query and the caller on every
// page — so a tampered cursor can only move the starting key.
const CURSOR_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+[+-][0-9:]+\|[0-9a-f-]{36}$/i;

export function encodeExportCursor(occurredAtText: string, id: string): string {
  return Buffer.from(`${occurredAtText}|${id}`, 'utf8').toString('base64url');
}

export function decodeExportCursor(cursor: string): { occurredAt: string; id: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!CURSOR_PATTERN.test(raw)) return null;
  const sep = raw.lastIndexOf('|');
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
}


function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export interface ElevationAuditExportFilters {
  /** Half-open event window [from, to). */
  from: Date;
  to: Date;
  orgId?: string;
  siteId?: string;
  deviceId?: string;
  elevationRequestId?: string;
  eventType?: string;
}

export interface ElevationAuditExportPageInput {
  /** The caller's app-layer org condition (auth.orgCondition); RLS applies as well. */
  orgCondition: SQL | undefined;
  /** normalizeSiteAllowlist(perms.allowedSiteIds): undefined = unrestricted. */
  allowedSiteIds: readonly string[] | undefined;
  filters: ElevationAuditExportFilters;
  after: { occurredAt: string; id: string } | null;
  limit: number;
}

export interface ElevationAuditExportPage {
  records: ExportRecord[];
  hasMore: boolean;
  /** Empty string when this is the last page. */
  nextCursor: string;
}

/**
 * One page of the ledger, ascending (occurred_at, id). Must run inside the
 * caller's request DB context: it adds no system escalation, so RLS on both
 * tables bounds it to what the caller may read.
 */
export async function fetchElevationAuditExportPage(
  input: ElevationAuditExportPageInput,
): Promise<ElevationAuditExportPage> {
  const { filters: f } = input;
  const conditions: SQL[] = [];
  if (input.orgCondition) conditions.push(input.orgCondition);
  if (f.orgId) conditions.push(eq(elevationAudit.orgId, f.orgId));
  // Site-restricted technicians see only their sites; a request with no site
  // does not pass a restricted allowlist (matches the PAM list route).
  if (input.allowedSiteIds !== undefined) {
    conditions.push(
      input.allowedSiteIds.length === 0 ? sql`false` : inArray(elevationRequests.siteId, [...input.allowedSiteIds]),
    );
  }
  if (f.siteId) conditions.push(eq(elevationRequests.siteId, f.siteId));
  if (f.deviceId) conditions.push(eq(elevationRequests.deviceId, f.deviceId));
  if (f.elevationRequestId) conditions.push(eq(elevationAudit.elevationRequestId, f.elevationRequestId));
  if (f.eventType) conditions.push(sql`${elevationAudit.eventType}::text = ${f.eventType}`);
  conditions.push(gte(elevationAudit.occurredAt, f.from));
  conditions.push(lt(elevationAudit.occurredAt, f.to));
  if (input.after) {
    // Compare at full Postgres precision: the cursor carries the text form of
    // occurred_at, never a millisecond-rounded JS Date.
    conditions.push(
      sql`(${elevationAudit.occurredAt}, ${elevationAudit.id}) > (${input.after.occurredAt}::timestamptz, ${input.after.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      audit: elevationAudit,
      occurredAtText: sql<string>`${elevationAudit.occurredAt}::text`,
      request: {
        deviceId: elevationRequests.deviceId,
        siteId: elevationRequests.siteId,
        flowType: elevationRequests.flowType,
        subjectUserId: elevationRequests.subjectUserId,
        subjectUsername: elevationRequests.subjectUsername,
        reason: elevationRequests.reason,
        targetExecutablePath: elevationRequests.targetExecutablePath,
        targetExecutableHash: elevationRequests.targetExecutableHash,
        targetExecutableSigner: elevationRequests.targetExecutableSigner,
        targetPublisher: elevationRequests.targetPublisher,
        status: elevationRequests.status,
        revision: elevationRequests.revision,
        requestedAt: elevationRequests.requestedAt,
        approvedAt: elevationRequests.approvedAt,
        approvedByUserId: elevationRequests.approvedByUserId,
        deniedByUserId: elevationRequests.deniedByUserId,
        denialReason: elevationRequests.denialReason,
        expiresAt: elevationRequests.expiresAt,
        revokedAt: elevationRequests.revokedAt,
        revokedByUserId: elevationRequests.revokedByUserId,
        revokedReason: elevationRequests.revokedReason,
        executionId: elevationRequests.executionId,
        toolName: elevationRequests.toolName,
        actionDigest: elevationRequests.actionDigest,
        riskTier: elevationRequests.riskTier,
        decidedAssuranceLevel: elevationRequests.decidedAssuranceLevel,
        decidedVia: elevationRequests.decidedVia,
      },
    })
    .from(elevationAudit)
    // Join on BOTH keys, mirroring the composite FK.
    .innerJoin(
      elevationRequests,
      and(
        eq(elevationRequests.id, elevationAudit.elevationRequestId),
        eq(elevationRequests.orgId, elevationAudit.orgId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(elevationAudit.occurredAt), asc(elevationAudit.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeExportCursor(last.occurredAtText, last.audit.id) : '';

  const records: ExportRecord[] = page.map(({ audit, request: r }) => ({
    id: audit.id,
    org_id: audit.orgId,
    elevation_request_id: audit.elevationRequestId,
    event_type: audit.eventType,
    actor: audit.actor,
    actor_user_id: audit.actorUserId ?? null,
    occurred_at: toIso(audit.occurredAt),
    created_at: toIso(audit.createdAt),
    details: projectAuditDetails(audit.details),
    request_device_id: r.deviceId ?? null,
    request_site_id: r.siteId ?? null,
    request_flow_type: r.flowType ?? null,
    request_subject_user_id: r.subjectUserId ?? null,
    request_subject_username: r.subjectUsername ?? null,
    request_reason: r.reason ?? null,
    request_target_executable_path: r.targetExecutablePath ?? null,
    request_target_executable_hash: r.targetExecutableHash ?? null,
    request_target_executable_signer: r.targetExecutableSigner ?? null,
    request_target_publisher: r.targetPublisher ?? null,
    request_status: r.status ?? null,
    request_revision: r.revision ?? null,
    request_requested_at: toIso(r.requestedAt),
    request_approved_at: toIso(r.approvedAt),
    request_approved_by_user_id: r.approvedByUserId ?? null,
    request_denied_by_user_id: r.deniedByUserId ?? null,
    request_denial_reason: r.denialReason ?? null,
    request_expires_at: toIso(r.expiresAt),
    request_revoked_at: toIso(r.revokedAt),
    request_revoked_by_user_id: r.revokedByUserId ?? null,
    request_revoked_reason: r.revokedReason ?? null,
    request_execution_id: r.executionId ?? null,
    request_tool_name: r.toolName ?? null,
    request_action_digest: r.actionDigest ?? null,
    request_risk_tier: r.riskTier ?? null,
    request_decided_assurance_level: r.decidedAssuranceLevel ?? null,
    request_decided_via: r.decidedVia ?? null,
  }));

  return { records, hasMore, nextCursor };
}

/**
 * CSV: header on every page, every cell through csvRow (formula-neutralized,
 * RFC 4180 quoted); the projected details object is JSON-encoded first.
 * JSONL: one JSON object per line, strings untouched.
 */
export function serializeElevationAuditPage(records: ExportRecord[], format: 'csv' | 'jsonl'): string {
  if (format === 'jsonl') {
    return records.map((record) => `${JSON.stringify(record)}\n`).join('');
  }
  const lines = [csvRow(PAM_AUDIT_EXPORT_COLUMNS)];
  for (const record of records) {
    lines.push(
      csvRow(
        PAM_AUDIT_EXPORT_COLUMNS.map((column) => {
          const value = record[column];
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        }),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}
