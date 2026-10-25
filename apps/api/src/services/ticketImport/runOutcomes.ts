import { createHash } from 'node:crypto';
import { MigrationWindowError } from '../migrationWindows';
import { TicketServiceError } from '../ticketService';
import { IMPORT_ATTACHMENT_MAX_BYTES } from './importAttachments';
import type { ImportedTicket } from './importedTicket';
import type { ImportTicketResult } from './importWriter';
import type { Conversion, ReportNote } from './moduleContract';
import type { IssueBuffer, RunCounters, RunIssue } from './runReport';
import { SourceAuthError, SourceHttpError, SourceResponseTooLargeError, SourceUnavailableError } from './sourceFetch';

/**
 * The pure decisions of a slice (#8313 W4; spec 2026-10-19 §5.2, §5.8–§5.10):
 * what a conversion's notes, an import result and an error mean for the
 * ledger, the counters and the report. No I/O.
 */

/** A source time clamped to now, or a ticket that fails `clock_skew` (§5.2). */
export function clampTicketTimes(
  ticket: ImportedTicket,
  now: Date,
  maxSkewMs: number,
): { kind: 'ok'; ticket: ImportedTicket; clamped: boolean } | { kind: 'clock_skew' } {
  const nowMs = now.getTime();
  let clamped = false;
  let tooFar = false;
  const fix = (d: Date): Date => {
    const ahead = d.getTime() - nowMs;
    if (ahead <= 0) return d;
    if (ahead > maxSkewMs) {
      tooFar = true;
      return d;
    }
    clamped = true;
    return new Date(nowMs);
  };
  const out: ImportedTicket = {
    ...ticket,
    createdAt: fix(ticket.createdAt),
    updatedAt: fix(ticket.updatedAt),
    ...(ticket.resolvedAt ? { resolvedAt: fix(ticket.resolvedAt) } : {}),
    ...(ticket.closedAt ? { closedAt: fix(ticket.closedAt) } : {}),
    comments: ticket.comments.map((comment) => ({ ...comment, createdAt: fix(comment.createdAt) })),
  };
  return tooFar ? { kind: 'clock_skew' } : { kind: 'ok', ticket: out, clamped };
}

/** The converted content of one ticket in UTF-8 bytes, against TICKET_IMPORT_MAX_TICKET_BYTES (§11). */
export function importedTicketBytes(ticket: ImportedTicket): number {
  let bytes = Buffer.byteLength(ticket.subject) + Buffer.byteLength(ticket.description) + Buffer.byteLength(ticket.resolutionNote ?? '');
  for (const comment of ticket.comments) {
    bytes += Buffer.byteLength(comment.content) + Buffer.byteLength(comment.author.name) + Buffer.byteLength(comment.author.email ?? '');
    for (const file of comment.attachments ?? []) bytes += Buffer.byteLength(file.filename);
  }
  return bytes;
}

export type IssueTarget = { key: string; number: string | null };

/**
 * A conversion's notes into counters and, where the report lists one, issues
 * (§5.10). An unmatched owner goes to `owners`: its row is written with the
 * next commit against a unique index, once per distinct owner per run, and
 * `ownersUnmatched` counts the rows that index let in (review #13). Owner
 * rows are bounded by the source's owners, so the issue cap does not apply.
 */
export function applyNotes(
  notes: readonly ReportNote[],
  counters: RunCounters,
  issues: IssueBuffer,
  owners: RunIssue[],
  target: IssueTarget,
): void {
  for (const note of notes) {
    switch (note.kind) {
      case 'owner_unmatched':
        owners.push({ sourceTicketKey: target.key, sourceTicketNumber: target.number, kind: 'owner_unmatched', code: note.sourceUserKey.slice(0, 64), count: 1 });
        break;
      case 'requester_without_contact':
        counters.requestersWithoutContact += 1;
        break;
      case 'content_truncated': {
        const n = Math.max(1, note.count ?? 1);
        counters.contentTruncated += n;
        issues.add({ sourceTicketKey: target.key, sourceTicketNumber: target.number, kind: 'content_truncated', code: null, count: n });
        break;
      }
      case 'comments_system_skipped':
        counters.comments.systemSkipped += Math.max(0, note.count);
        break;
      case 'attachments_alternative_ignored':
        counters.attachments.alternativesIgnored += Math.max(0, note.count);
        break;
      case 'custom_attribute': {
        const name = note.name.slice(0, 128);
        counters.customAttributes[name] = (counters.customAttributes[name] ?? 0) + Math.max(1, note.count ?? 1);
        break;
      }
      case 'module_count': {
        const name = note.name.slice(0, 64);
        counters.moduleCounts[name] = (counters.moduleCounts[name] ?? 0) + Math.max(0, note.count ?? 1);
        break;
      }
    }
  }
}

/**
 * A completed import's report-only detail (§5.9, §5.10): the writer's status
 * decision, skipped files, and what changed in the source that v1 does not
 * converge on. Comments made internal in the source sort first in the
 * report, so their issue carries the code `made_internal`.
 */
export function recordImportResult(
  result: ImportTicketResult,
  counters: RunCounters,
  issues: IssueBuffer,
  target: IssueTarget,
): void {
  if (result.outcome === 'created') counters.tickets.created += 1;
  else if (result.outcome === 'resumed') counters.tickets.resumed += 1;
  counters.comments.written += result.commentsWritten;
  counters.comments.skipped += result.commentsSkipped;
  counters.attachments.written += result.attachmentsWritten;
  counters.attachments.bytes += result.attachmentBytes;
  const base = { sourceTicketKey: target.key, sourceTicketNumber: target.number };

  if (result.statusSkipped) {
    counters.statusKept += 1;
    const s = result.statusSkip;
    issues.add({ ...base, kind: 'status_kept', code: s ? `${s.sourceStatus}:${s.currentStatus}:${s.statusOwner.kind}`.slice(0, 64) : null });
  }
  // `present_elsewhere`: already in Breeze on another ticket, not a loss.
  const skipped = result.attachmentsSkipped.filter((s) => s.reason !== 'present_elsewhere');
  counters.attachments.skipped += skipped.length;
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  for (const [reason, n] of byReason) issues.add({ ...base, kind: 'attachments_skipped', code: reason, count: n });

  if (result.commentsChangedInSource.length > 0) {
    counters.commentsChangedInSource += result.commentsChangedInSource.length;
    const madeInternal = result.commentsChangedInSource.some((c) => c.visibility === 'made_internal');
    issues.add({ ...base, kind: 'comments_changed', code: madeInternal ? 'made_internal' : 'changed', count: result.commentsChangedInSource.length });
  }
  if (result.commentsMissingInSource.length > 0) {
    counters.commentsMissingInSource += result.commentsMissingInSource.length;
    issues.add({ ...base, kind: 'comments_missing', code: null, count: result.commentsMissingInSource.length });
  }
  if (result.requesterChanged) {
    counters.requestersChangedInSource += 1;
    issues.add({ ...base, kind: 'requester_changed', code: null });
  }
  if (result.orgChanged) {
    counters.orgsChangedInSource += 1;
    issues.add({ ...base, kind: 'org_changed', code: null });
  }
}

/** What a dry run predicts for one valid ticket (§5.9): no window, no writes, no downloads. */
export function predictTicket(ticket: ImportedTicket, counters: RunCounters, resumes: boolean): void {
  if (resumes) counters.predicted.resumes += 1;
  else counters.predicted.creates += 1;
  counters.predicted.comments += ticket.comments.length;
  for (const file of ticket.comments.flatMap((c) => c.attachments ?? [])) {
    const declared = file.declaredBytes;
    if (declared !== undefined && (declared === 0 || declared > IMPORT_ATTACHMENT_MAX_BYTES)) {
      counters.predicted.attachmentsSkipped += 1;
      continue;
    }
    counters.predicted.attachments += 1;
    counters.predicted.attachmentBytes += declared ?? 0;
  }
}

/** What an `importTicket` failure means for the run (§5.8). */
export type ImportFailure =
  | { kind: 'failed'; code: string }
  | { kind: 'stop'; reason: string }
  | { kind: 'defer'; delayMs: number }
  | { kind: 'rethrow' };

export function classifyImportError(error: unknown): ImportFailure {
  if (error instanceof MigrationWindowError) {
    switch (error.code) {
      case 'MIGRATION_WINDOW_NOT_OPEN':
        return { kind: 'stop', reason: 'window_closed' };
      case 'MIGRATION_WINDOW_RATE_LIMITED': {
        // Either bucket (writes or bytes): the job waits, spending no attempt.
        const seconds = Number(error.details?.retryAfterSeconds);
        return { kind: 'defer', delayMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000 };
      }
      case 'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED':
        return { kind: 'stop', reason: 'object_storage_required' };
      case 'MIGRATION_SOURCE_ID_IN_USE': {
        // live_ticket, other_principal_ticket, org_outside_window, deleted, ...
        const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'source_id_in_use';
        return { kind: 'failed', code: reason.slice(0, 64) };
      }
      case 'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE':
        // W1: transient; the item fails for this pass and the next run retries it (§4.3).
        return { kind: 'failed', code: 'attachment_unavailable' };
      case 'MIGRATION_WINDOW_ORG_NOT_ALLOWED':
        return { kind: 'failed', code: 'org_outside_window' };
      default:
        return { kind: 'failed', code: error.code };
    }
  }
  if (error instanceof TicketServiceError && error.status < 500) {
    return { kind: 'failed', code: (error.code ?? `ticket_${error.status}`).slice(0, 64) };
  }
  return { kind: 'rethrow' };
}

/** What a source call failure (scan, load, probe) means (§5.8). */
export type SourceFailure =
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'unauthorized' }
  | { kind: 'http'; status: number }
  | { kind: 'too_large' }
  | { kind: 'rethrow' };

export function classifySourceError(error: unknown): SourceFailure {
  if (error instanceof SourceAuthError) return { kind: 'unauthorized' };
  if (error instanceof SourceHttpError) return { kind: 'http', status: error.status };
  if (error instanceof SourceUnavailableError) return { kind: 'unavailable', retryAfterMs: error.retryAfterMs };
  if (error instanceof SourceResponseTooLargeError) return { kind: 'too_large' };
  return { kind: 'rethrow' };
}

/**
 * A fault of Breeze's own infrastructure rather than of the ticket being
 * imported (review #1): a lost slice claim, a database connection or server
 * failure, a pool that cannot hand out a connection. Such an error ends the
 * slice (BullMQ retries it from the saved position); anything else that
 * happens while one ticket is loaded, converted or written fails only that
 * ticket. Walks the `cause` chain, as the writer wraps some failures.
 */
const DRIVER_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
]);
// 08 connection exception, 53 insufficient resources, 58 system error; and
// 57P01–57P03 (admin shutdown, crash shutdown, cannot connect now), 25P03
// (idle-in-transaction timeout). A statement timeout (57014) is the ticket's.
const INFRA_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(['08', '53', '58']);
const INFRA_SQLSTATES: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03', '25P03']);
const INFRA_ERROR_NAMES: ReadonlySet<string> = new Set(['SliceSupersededError', 'DbPoolAcquireAbortedError']);

export function isInfrastructureError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const e = cursor as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof e.name === 'string' && INFRA_ERROR_NAMES.has(e.name)) return true;
    if (typeof e.code === 'string') {
      if (DRIVER_ERROR_CODES.has(e.code)) return true;
      if (/^[0-9A-Z]{5}$/.test(e.code) && (INFRA_SQLSTATES.has(e.code) || INFRA_SQLSTATE_CLASSES.has(e.code.slice(0, 2)))) return true;
    }
    cursor = e.cause;
  }
  return false;
}

/**
 * The module contract on ids (§5.2): a conversion imports the ticket its row
 * names. A ticket whose `sourceId` is not the row's key would be resumed and
 * reported under another ticket's key, so it is refused visibly
 * (`module_contract_violation`), and a module bug shows in its first dry run.
 */
export function conversionIdentityViolation(conversion: Conversion, rowKey: string): boolean {
  return conversion.kind === 'ticket' && conversion.ticket.sourceId !== rowKey;
}

/**
 * The one stored and compared form of a source version (review #15): the
 * version itself up to 64 characters (the ledger's varchar(64)); a longer one
 * becomes `sha256:` and 57 hex characters of its digest, a fixed 64. Applied
 * wherever a version is stored or compared, so two long versions that share
 * their first 64 characters never read as the same.
 */
export const VERSION_KEY_MAX = 64;

export function versionKey(version: string): string {
  if (version.length <= VERSION_KEY_MAX) return version;
  return `sha256:${createHash('sha256').update(version).digest('hex').slice(0, VERSION_KEY_MAX - 'sha256:'.length)}`;
}
