/**
 * AI transcript retention predicates (#4342 W4).
 *
 * The ONLY eligibility predicates for the transcript retention job
 * (`jobs/aiTranscriptRetention.ts`) and the three settings previews. The
 * report count, the enforce batch and the preview call the same builder with
 * the same inputs, so the number an admin or operator approves is the set the
 * job acts on (plan, Global Constraints: "one predicate builder per target").
 *
 * Every builder references the outer table by its bare name `ai_sessions`
 * (`countEligibleRows` selects `FROM ai_sessions` unaliased); inner subqueries
 * alias their own tables.
 *
 * `last_activity_at` and `ai_messages.created_at` are `timestamp without time
 * zone` holding UTC, so every cutoff goes through `utcWallTime`.
 *
 * STUB (phases 1–2), all must hold:
 *   - the org's session of the given kind (technician = every type that is not
 *     a client type; client = `CLIENT_SESSION_TYPES`);
 *   - not yet a stub (`transcript_purged_at IS NULL`) and not flagged (OD 2:
 *     a flagged session is held while flagged);
 *   - `last_activity_at` older than the window;
 *   - `closed`/`expired`, or `active` and idle a further
 *     `LIVE_SESSION_MAX_DEFER_MS` past the window (plan correction 6: a session
 *     whose process died stays `active` forever);
 *   - no message inside `LIVE_SESSION_QUIET_MS` (the session may still be in
 *     an API process's memory).
 *
 * STUB DELETE (phase 3): a stub, unflagged, whose `last_activity_at` is older
 * than the org's audit-retention window, with no `ai_screenshots` row left
 * (the stub batch expires them so `helperScreenshotRetention` removes file and
 * row first; a cascaded row would orphan its file). Orgs with no
 * `audit_retention_policies` row never reach this predicate: the job skips
 * them (their `audit_logs` are kept forever, so the stub is too).
 */
import { sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { retentionEnforceFromEnv, utcWallTime } from '../jobs/retentionBatch';
import { CLIENT_SESSION_TYPES } from './clientAiHosts';

/**
 * `AI_TRANSCRIPT_RETENTION_ENFORCE`, read once. Code default FALSE (the spec's
 * preview release, §3.4): the job only counts. The previews report it as
 * `enforced` so the cards say "once retention is enforced" vs "in the next
 * nightly run".
 */
export const AI_TRANSCRIPT_RETENTION_ENFORCE = retentionEnforceFromEnv(
  '[AiTranscriptRetention]', 'AI_TRANSCRIPT_RETENTION_ENFORCE', false,
);

/**
 * Longer than the 2 h in-memory idle eviction (`SESSION_IDLE_TIMEOUT_MS`,
 * streamingSessionManager.ts), with margin for the eviction tick. Shared with
 * `jobs/aiToolOutputRetention.ts`.
 */
export const LIVE_SESSION_QUIET_MS = 3 * 60 * 60 * 1000;
/** How far past its window a live (or abandoned `active`) session may be deferred. */
export const LIVE_SESSION_MAX_DEFER_MS = 24 * 60 * 60 * 1000;

export type TranscriptSessionKind = 'technician' | 'client';

function clientTypeList(): SQL {
  if (CLIENT_SESSION_TYPES.length === 0) {
    // `IN ()` is a syntax error and `NOT IN ()` would match nothing: never guess.
    throw new Error('[aiTranscriptRetention] CLIENT_SESSION_TYPES is empty');
  }
  return sql.join(CLIENT_SESSION_TYPES.map((t) => sql`${t}`), sql`, `);
}

function stubPredicate(kind: TranscriptSessionKind, orgId: string, cutoffIso: string, now: Date): SQL {
  const types = clientTypeList();
  const kindClause = kind === 'client'
    ? sql`ai_sessions.type IN (${types})`
    : sql`ai_sessions.type NOT IN (${types})`;
  const abandonedActiveIso = new Date(Date.parse(cutoffIso) - LIVE_SESSION_MAX_DEFER_MS).toISOString();
  const quietSinceIso = new Date(now.getTime() - LIVE_SESSION_QUIET_MS).toISOString();
  return sql`ai_sessions.org_id = ${orgId}::uuid
    AND ${kindClause}
    AND ai_sessions.transcript_purged_at IS NULL
    AND ai_sessions.flagged_at IS NULL
    AND ai_sessions.last_activity_at < ${utcWallTime(cutoffIso)}
    AND (
      ai_sessions.status IN ('closed', 'expired')
      OR (ai_sessions.status = 'active' AND ai_sessions.last_activity_at < ${utcWallTime(abandonedActiveIso)})
    )
    AND NOT EXISTS (
      SELECT 1 FROM ai_messages live
      WHERE live.session_id = ai_sessions.id
        AND live.created_at >= ${utcWallTime(quietSinceIso)}
    )`;
}

/** Phase 1: technician sessions (every type that is not a client type). */
export function technicianStubPredicate(orgId: string, cutoffIso: string, now: Date): SQL {
  return stubPredicate('technician', orgId, cutoffIso, now);
}

/** Phase 2: client (AI for Office) sessions. */
export function clientStubPredicate(orgId: string, cutoffIso: string, now: Date): SQL {
  return stubPredicate('client', orgId, cutoffIso, now);
}

export function stubPredicateFor(kind: TranscriptSessionKind, orgId: string, cutoffIso: string, now: Date): SQL {
  return stubPredicate(kind, orgId, cutoffIso, now);
}

/** Phase 3: hard-delete stubs past the org's audit-retention window. */
export function stubDeletePredicate(orgId: string, auditCutoffIso: string): SQL {
  return sql`ai_sessions.org_id = ${orgId}::uuid
    AND ai_sessions.transcript_purged_at IS NOT NULL
    AND ai_sessions.flagged_at IS NULL
    AND ai_sessions.last_activity_at < ${utcWallTime(auditCutoffIso)}
    AND NOT EXISTS (
      SELECT 1 FROM ai_screenshots sc
      WHERE sc.session_id = ai_sessions.id
    )`;
}

/** Upper bound on a preview count; the UI renders `capped` as "N+". */
export const TRANSCRIPT_PREVIEW_CAP = 10_000;

/**
 * Bounded count of `ai_sessions` rows matching `where`, on the REQUEST path:
 * it runs through the ambient `db` under the caller's RLS context (never a
 * system escape), so a caller can only ever count sessions it can already see.
 * Scans at most `cap + 1` rows. Throws on an unreadable result rather than
 * reading it as 0.
 */
export async function countTranscriptPreview(
  where: SQL,
  cap: number = TRANSCRIPT_PREVIEW_CAP,
): Promise<{ eligible: number; capped: boolean }> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM (SELECT 1 FROM ai_sessions WHERE ${where} LIMIT ${cap + 1}) s
  `);
  const rows: unknown = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
  const raw = Array.isArray(rows) ? (rows[0] as { n?: unknown } | undefined)?.n : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[aiTranscriptRetention] preview count came back unreadable (${JSON.stringify(raw)})`);
  }
  return { eligible: Math.min(n, cap), capped: n > cap };
}

/** The window's cutoff instant for a preview or a run at `now`. */
export function transcriptCutoffIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
