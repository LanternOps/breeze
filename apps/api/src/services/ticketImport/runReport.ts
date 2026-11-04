/**
 * The run report (#8313 W4; spec 2026-10-19 §5.10): typed counters, kept on
 * the run row and exact for the whole run, and issue rows, one per ticket
 * and kind, with at most TICKET_IMPORT_MAX_ISSUES_PER_RUN of them. Issue rows
 * carry source keys, source numbers and codes, never ticket content: names
 * and filenames stay inside the tickets' own internal notes, so an org's
 * erasure leaves nothing personal in the partner-level report.
 */

export const RUN_ISSUE_KINDS = [
  // Skipped or failed.
  'skipped_no_org',
  'skipped_unsupported',
  'failed',
  // Writer decisions.
  'status_kept',
  'attachments_skipped',
  'link_not_written',
  // People: once per distinct source owner; the code is the source user key.
  'owner_unmatched',
  // Changed in the source (report-only in v1, §5.9).
  'comments_changed',
  'comments_missing',
  'requester_changed',
  'org_changed',
  'deleted_in_source',
  'hidden_in_source',
  // A deletions probe the source could not answer now: the ticket stays
  // imported and unseen, and the next run probes it again (review #5).
  'probe_deferred',
  // Removed or merged in Breeze (final, §5.9).
  'removed_in_breeze',
  'merged_in_breeze',
  // Content.
  'content_truncated',
] as const;
export type RunIssueKind = (typeof RUN_ISSUE_KINDS)[number];

export type RunIssue = {
  sourceTicketKey: string | null;
  sourceTicketNumber: string | null;
  kind: RunIssueKind;
  code: string | null;
  count: number;
};

export type RunCounters = {
  tickets: { seen: number; created: number; resumed: number; unchanged: number; skipped: number; failed: number };
  comments: { written: number; skipped: number; systemSkipped: number };
  attachments: { written: number; skipped: number; bytes: number; alternativesIgnored: number };
  linksWritten: number;
  /** Links the conversion asked for that stay as its note (no import-mode link writer yet, or not writable). */
  linksAsNotes: number;
  statusKept: number;
  contentTruncated: number;
  clockClamped: number;
  deletedInSource: number;
  hiddenInSource: number;
  removedInBreeze: number;
  mergedInBreeze: number;
  /** Distinct source owners matched to no user. */
  ownersUnmatched: number;
  requestersWithoutContact: number;
  /** Contacts the import created (W4b; 0 until then). */
  contactsCreated: number;
  commentsChangedInSource: number;
  commentsMissingInSource: number;
  requestersChangedInSource: number;
  orgsChangedInSource: number;
  /** Custom attributes with a value, by name (not imported in v1). */
  customAttributes: Record<string, number>;
  issuesWritten: number;
  /** Issues past TICKET_IMPORT_MAX_ISSUES_PER_RUN: counted here, not written. */
  issuesDropped: number;
  /** A dry run's predictions of what an import would do. */
  predicted: {
    creates: number;
    resumes: number;
    comments: number;
    attachments: number;
    /** Declared sizes; a dry run downloads nothing. */
    attachmentBytes: number;
    /** Files an import would skip by their declared size (over the cap, or empty). */
    attachmentsSkipped: number;
    /** Tickets that would fail validation. */
    invalid: number;
    /** Contacts an import would create, per org (W4b; empty until then). */
    contactsToCreate: Record<string, number>;
  };
};

export function emptyCounters(): RunCounters {
  return {
    tickets: { seen: 0, created: 0, resumed: 0, unchanged: 0, skipped: 0, failed: 0 },
    comments: { written: 0, skipped: 0, systemSkipped: 0 },
    attachments: { written: 0, skipped: 0, bytes: 0, alternativesIgnored: 0 },
    linksWritten: 0,
    linksAsNotes: 0,
    statusKept: 0,
    contentTruncated: 0,
    clockClamped: 0,
    deletedInSource: 0,
    hiddenInSource: 0,
    removedInBreeze: 0,
    mergedInBreeze: 0,
    ownersUnmatched: 0,
    requestersWithoutContact: 0,
    contactsCreated: 0,
    commentsChangedInSource: 0,
    commentsMissingInSource: 0,
    requestersChangedInSource: 0,
    orgsChangedInSource: 0,
    customAttributes: {},
    issuesWritten: 0,
    issuesDropped: 0,
    predicted: {
      creates: 0,
      resumes: 0,
      comments: 0,
      attachments: 0,
      attachmentBytes: 0,
      attachmentsSkipped: 0,
      invalid: 0,
      contactsToCreate: {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function countMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, count(v)]));
}

/** The stored counters, with every field present (a run row starts as `{}`). */
export function normalizeCounters(raw: unknown): RunCounters {
  const base = emptyCounters();
  if (!isRecord(raw)) return base;
  const out = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) {
    const stored = raw[key];
    if (key === 'customAttributes') out[key] = countMap(stored);
    else if (key === 'predicted') {
      const p = isRecord(stored) ? stored : {};
      out[key] = {
        ...Object.fromEntries(Object.keys(base.predicted).map((k) => [k, count(p[k])])),
        contactsToCreate: countMap(p.contactsToCreate),
      };
    } else if (isRecord(value)) {
      const nested = isRecord(stored) ? stored : {};
      out[key] = Object.fromEntries(Object.keys(value).map((k) => [k, count(nested[k])]));
    } else {
      out[key] = count(stored);
    }
  }
  return base;
}

/**
 * Collects a slice's issue rows under the run's cap: an issue past the cap is
 * counted in `issuesDropped` instead of written. The counters stay exact
 * either way.
 */
export class IssueBuffer {
  private readonly pending: RunIssue[] = [];

  constructor(private readonly counters: RunCounters, private readonly maxIssues: number) {}

  add(issue: Omit<RunIssue, 'count'> & { count?: number }): void {
    if (this.counters.issuesWritten >= this.maxIssues) {
      this.counters.issuesDropped += 1;
      return;
    }
    this.counters.issuesWritten += 1;
    this.pending.push({ ...issue, count: Math.max(1, issue.count ?? 1) });
  }

  /** The rows to write with the next commit; empties the buffer. */
  take(): RunIssue[] {
    return this.pending.splice(0, this.pending.length);
  }
}
