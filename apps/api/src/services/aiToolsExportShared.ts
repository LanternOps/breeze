/**
 * Shared groundwork for the set-based `export_dataset` adapters (Wisp analysis
 * sessions W04, W00 C6/C8): the time range, the keyset cursor and pager, the
 * run's device set, and the explicit text redaction every free-text column goes
 * through.
 *
 * The cost rule these exist to enforce: an adapter resolves the run's frozen
 * device set ONCE (`exportDeviceSet`, one `devices` query), then reads one
 * keyset page per call filtered by `device_id = ANY($1::uuid[])`. It never
 * loops over devices. At a 5000-device frame that is 1 + ceil(rows / page)
 * queries, whatever the frame size.
 *
 * Only `import type` from the hub (`aiToolsExportDatasets.ts`), so this file
 * stays out of the hub's import cycle.
 */
import { and, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { deviceSiteDenied } from './aiToolsSiteScope';
import {
  redactAgentLogFields,
  redactAgentLogMessage,
  redactLogFields,
  redactLogMessage,
} from './logRedaction';
import { hmacFingerprint } from './secretCrypto';
import { scrubUrlsInText, scrubUrlsInValue } from '../utils/endpointDisplay';
import type { DatasetRequest } from './aiToolsExportDatasets';
import type { AnalysisSensitiveGate } from '../db/schema/aiAgents';
import type { ExportPager } from './aiToolsExportWriter';

// ---------------------------------------------------------------------------
// Filter errors and the time range
// ---------------------------------------------------------------------------

/** A filter the model supplied that the export cannot honour. The handler
 *  returns `{ error: code, message }`, so the model can correct the call. */
export class ExportFilterError extends Error {
  constructor(readonly code: 'invalid_time_range' | 'invalid_filter', message: string) {
    super(message);
    this.name = 'ExportFilterError';
  }
}

export const EXPORT_TIME_RANGE_DEFAULT_DAYS = 30;
export const EXPORT_TIME_RANGE_MAX_DAYS = 180;
export const EXPORT_TEXT_MAX_CHARS = 2000;

const DAY_MS = 86_400_000;

function parseRangeBound(value: unknown, name: 'start' | 'end'): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ExportFilterError('invalid_time_range', `filters.timeRange.${name} must be an ISO 8601 date-time string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ExportFilterError('invalid_time_range', `filters.timeRange.${name} is not a valid ISO 8601 date-time.`);
  }
  return parsed;
}

/**
 * `filters.timeRange { start?, end? }` (ISO). Absent → the last 30 days.
 * `end` only → the 30 days before it. `start` only → from it to now. A
 * non-object, an unparseable bound, `start > end`, or a span over 180 days
 * throws `ExportFilterError('invalid_time_range')`.
 */
export function timeRangeFromFilters(
  filters: Record<string, unknown>,
  now: () => Date = () => new Date(),
): { start: Date; end: Date } {
  const raw = filters.timeRange;
  if (raw === undefined || raw === null) {
    const end = now();
    return { start: new Date(end.getTime() - EXPORT_TIME_RANGE_DEFAULT_DAYS * DAY_MS), end };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExportFilterError('invalid_time_range', 'filters.timeRange must be an object { start, end } of ISO 8601 date-times.');
  }
  const range = raw as { start?: unknown; end?: unknown };
  const start = parseRangeBound(range.start, 'start');
  const end = parseRangeBound(range.end, 'end');
  const resolvedEnd = end ?? now();
  const resolvedStart = start ?? new Date(resolvedEnd.getTime() - EXPORT_TIME_RANGE_DEFAULT_DAYS * DAY_MS);
  if (resolvedStart.getTime() > resolvedEnd.getTime()) {
    throw new ExportFilterError('invalid_time_range', 'filters.timeRange.start is after its end.');
  }
  if (resolvedEnd.getTime() - resolvedStart.getTime() > EXPORT_TIME_RANGE_MAX_DAYS * DAY_MS) {
    throw new ExportFilterError(
      'invalid_time_range',
      `filters.timeRange spans more than ${EXPORT_TIME_RANGE_MAX_DAYS} days; narrow it.`,
    );
  }
  return { start: resolvedStart, end: resolvedEnd };
}

// ---------------------------------------------------------------------------
// Keyset cursor
// ---------------------------------------------------------------------------

/** The kind of each part of a keyset key, validated before it reaches a cast. */
export type KeyPart = 'timestamp' | 'timestamptz' | 'uuid' | 'int';

// `col::text` of a Postgres `timestamp`: `YYYY-MM-DD HH:MM:SS[.ffffff]`.
const TIMESTAMP_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
// `col::text` of a `timestamptz`: the same plus the session offset (`+00`, `+05:30`, `-03:00:00`).
const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2}){0,2})?$/;
// A non-negative offset into a row (a sub-row resume point), at most nine digits.
const INT_RE = /^\d{1,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_PART_RE: Record<KeyPart, RegExp> = {
  timestamp: TIMESTAMP_TEXT_RE,
  timestamptz: TIMESTAMPTZ_TEXT_RE,
  uuid: UUID_RE,
  int: INT_RE,
};

/** base64url JSON array of the last emitted row's key texts. */
export function encodeExportCursor(key: readonly string[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/**
 * The key a cursor carries, every part validated against `shape`. The cursor
 * is internal (the writer feeds back what the pager emitted), so a mismatch is
 * a bug and throws rather than resetting to page one.
 */
export function decodeExportCursor(cursor: string | null, shape: readonly KeyPart[]): string[] | null {
  if (cursor === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('export cursor is not readable');
  }
  if (!Array.isArray(parsed) || parsed.length !== shape.length) {
    throw new Error('export cursor does not match the dataset key');
  }
  parsed.forEach((part, i) => {
    if (typeof part !== 'string' || !KEY_PART_RE[shape[i]!].test(part)) {
      throw new Error('export cursor does not match the dataset key');
    }
  });
  return parsed as string[];
}

/**
 * Page predicate for `(ts, id) DESC`: strictly before the last key, compared in
 * Postgres at full column precision (the key text comes from `col::text`, never
 * from a JS Date; see `aiToolPagination.ts` Q1). The redundant `ts <= t` bound
 * lets the planner use an index that leads on the time column without `id`.
 * Undefined on the first page.
 */
export function keysetBefore(
  tsCol: AnyColumn,
  idCol: AnyColumn,
  after: string[] | null,
  kind: 'timestamp' | 'timestamptz',
): SQL | undefined {
  if (!after) return undefined;
  const [t, i] = after;
  const cast = sql.raw(kind === 'timestamptz' ? '::timestamptz' : '::timestamp');
  return sql`(${tsCol} <= ${t}${cast} AND (${tsCol}, ${idCol}) < (${t}${cast}, ${i}::uuid))`;
}

/** Page predicate for uuid keys ascending: `(cols) > (key)`. Undefined on the first page. */
export function keysetAfterIds(cols: readonly AnyColumn[], after: string[] | null): SQL | undefined {
  if (!after) return undefined;
  const left = sql.join(cols.map((c) => sql`${c}`), sql`, `);
  const right = sql.join(after.map((v) => sql`${v}::uuid`), sql`, `);
  return sql`(${left}) > (${right})`;
}

/**
 * A keyset pager: fetches `pageSize + 1` rows, emits the first `pageSize`, and
 * sets `nextCursor` from the last emitted row only when the extra row came
 * back. An exact multiple of `pageSize` therefore ends without an empty page.
 */
export function keysetPager<R>(opts: {
  pageSize: number;
  shape: readonly KeyPart[];
  fetch: (after: string[] | null, limit: number) => Promise<R[]>;
  keyOf: (row: R) => string[];
  toRows: (rows: R[]) => Array<Record<string, unknown>>;
}): ExportPager {
  return async (cursor) => {
    const after = decodeExportCursor(cursor, opts.shape);
    const fetched = await opts.fetch(after, opts.pageSize + 1);
    const page = fetched.slice(0, opts.pageSize);
    const last = page[page.length - 1];
    return {
      rows: opts.toRows(page),
      nextCursor: fetched.length > opts.pageSize && last !== undefined
        ? encodeExportCursor(opts.keyOf(last))
        : null,
    };
  };
}

/** The single await point of an adapter query. Unit tests mock it and read `query.toSQL()`. */
export async function runExportQuery<T>(query: PromiseLike<T[]>): Promise<T[]> {
  return await query;
}

/** A pager that yields nothing: what an empty device set gets. */
export const emptyExportPager: ExportPager = async () => ({ rows: [], nextCursor: null });

/**
 * Whether the run's FROZEN export grants hold a sensitive gate (W05). The gate
 * was evaluated at admission against the live grant ceiling; nothing here, or
 * in an adapter, evaluates the run principal's own permissions (it has no
 * role). Legacy grants hold no gate.
 */
export function holdsSensitiveGate(req: DatasetRequest, gate: AnalysisSensitiveGate): boolean {
  return req.exportGrants.sensitiveGates.includes(gate);
}

/** Append a note for the run's model, once. */
export function noteOn(req: DatasetRequest, note: string): void {
  if (!req.notes.includes(note)) req.notes.push(note);
}

// ---------------------------------------------------------------------------
// Device set
// ---------------------------------------------------------------------------

/**
 * `column = ANY($1::uuid[])`: the whole set as ONE bind parameter, whatever its
 * size. Drizzle `inArray` would render one parameter per id (5000 at a full
 * frame) and a new statement text per frame size. Throws on an empty set;
 * callers return the empty pager first.
 */
export function deviceIdIn(column: AnyColumn, ids: readonly string[]): SQL {
  if (ids.length === 0) throw new Error('deviceIdIn: empty device set (callers must short-circuit)');
  return sql`${column} = ANY(${sql.param([...ids])}::uuid[])`;
}

export interface ExportDeviceScope {
  deviceIds: string[];
  hostnames: ReadonlyMap<string, string>;
}

const EMPTY_SCOPE: ExportDeviceScope = Object.freeze({ deviceIds: [], hostnames: new Map<string, string>() });

/**
 * The devices a set-based export may read: the run's frozen frame, narrowed by
 * the requested ids, the exact-device axis (`auth.allowedDeviceIds`) and the
 * site axis (`deviceSiteDenied`, which RLS does not enforce). An absent or
 * empty frame yields NOTHING: a W04+ dataset never exports org-wide. One
 * `devices` query, in the request org.
 */
export async function exportDeviceSet(req: DatasetRequest): Promise<ExportDeviceScope> {
  if (req.auth.orgId !== req.orgId) {
    throw new Error('export_dataset: the agent principal\'s organization does not match the requested organization');
  }
  if (!req.runTargets || req.runTargets.length === 0) return EMPTY_SCOPE;
  let candidates = [...new Set(req.runTargets)];
  if (req.deviceIds !== null) {
    const requested = new Set(req.deviceIds);
    candidates = candidates.filter((id) => requested.has(id));
  }
  const allowedDeviceIds = req.auth.allowedDeviceIds;
  if (Array.isArray(allowedDeviceIds)) {
    const allowed = new Set(allowedDeviceIds);
    candidates = candidates.filter((id) => allowed.has(id));
  }
  if (req.siteId !== null && req.auth.canAccessSite && !req.auth.canAccessSite(req.siteId)) return EMPTY_SCOPE;
  if (candidates.length === 0) return EMPTY_SCOPE;

  const rows = await db
    .select({ id: devices.id, siteId: devices.siteId, hostname: devices.hostname })
    .from(devices)
    .where(and(
      eq(devices.orgId, req.orgId),
      deviceIdIn(devices.id, candidates),
      req.siteId !== null ? eq(devices.siteId, req.siteId) : undefined,
    ));
  const inScope = rows.filter((row) => !deviceSiteDenied(req.auth, row.siteId, row.id));
  // Keep the frame's order: it is the run's own, stable across pages.
  const byId = new Map(inScope.map((row) => [row.id, row]));
  const deviceIds = candidates.filter((id) => byId.has(id));
  return {
    deviceIds,
    hostnames: new Map(deviceIds.map((id) => [id, byId.get(id)!.hostname])),
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const CUT_MARK = '…[cut]';

/** At most EXPORT_TEXT_MAX_CHARS code points; never splits a surrogate pair. */
export function cutExportText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= EXPORT_TEXT_MAX_CHARS) return text;
  return chars.slice(0, EXPORT_TEXT_MAX_CHARS - Array.from(CUT_MARK).length).join('') + CUT_MARK;
}

export interface ExportTextOptions {
  /** Scrub URLs (credentials and query strings) first. */
  urls?: boolean;
  /** Agent-collected text: also drop user-profile paths, home paths, UNC hosts and IPs. */
  paths?: boolean;
}

/** One free-text cell: redacted, then cut. Redaction runs first, so a secret straddling the cut is never half-emitted. */
export function exportText(value: unknown, opts: ExportTextOptions = {}): string | null {
  if (value === null || value === undefined) return null;
  let text = typeof value === 'string' ? value : String(value);
  if (opts.urls) text = scrubUrlsInText(text);
  text = opts.paths ? redactAgentLogMessage(text) : redactLogMessage(text);
  return cutExportText(text);
}

/** An agent-reported enumerated value: one of `known`, else the fixed `other`
 *  (absent → null). No agent-supplied free text passes through. */
export function exportEnum(value: unknown, known: ReadonlySet<string>): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && known.has(value) ? value : 'other';
}

/** A stable 32-hex key for an identifier that embeds agent text (a path, a
 *  name, an error code): rows still join and dedupe on it, but none of the
 *  text leaves. It is an HMAC (the server's fingerprint key, via
 *  `hmacFingerprint`) over the export's org id and the text, so a holder of
 *  the export cannot confirm a guessed input by hashing it, and two orgs never
 *  share a key. `orgId` is the export's frozen org (`DatasetRequest.orgId`),
 *  never model input. Stable within one org and one key generation.
 *  Absent → null. */
export function exportKey(orgId: string, value: unknown): string | null {
  if (!orgId) throw new Error('exportKey requires the export org id');
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // `fp1:<keyId>:<hex>`: keep the first 32 hex characters of the digest.
  const fingerprint = hmacFingerprint(`${orgId}\0${text}`);
  const hex = fingerprint.slice(fingerprint.lastIndexOf(':') + 1);
  return hex.slice(0, 32);
}

/** A JSON free-text column, redacted leaf by leaf, emitted as a string so CSV and JSONL carry the same type. */
export function exportJsonText(value: unknown, opts: ExportTextOptions = {}): string | null {
  if (value === null || value === undefined) return null;
  let redacted = opts.paths ? redactAgentLogFields(value) : redactLogFields(value);
  if (opts.urls) redacted = scrubUrlsInValue(redacted);
  return cutExportText(JSON.stringify(redacted));
}
