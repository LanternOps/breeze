/**
 * Wisp W05 — concerns: the triage engine's durable facts (Wisp design §7.1–7.4,
 * w00 "Triage engine (W05)", A30, A34).
 *
 * A concern is "something about a subject that may need a person". At most one
 * LIVE (open/snoozed) concern exists per subject and per correlator signature
 * (the two partial unique indexes on `wisp_concerns`). Per-grant nudge state
 * lives in `wisp_concern_recipients`, created on demand.
 *
 * Callers are workers, routes and chat tools alike, so every DB access runs
 * through `inSystemContext` and isolation is done here, from the GrantCeiling
 * (`listConcernsForCeiling` / `getConcernForCeiling`). The write helpers take
 * ids the caller already authorised; they never widen anything.
 *
 * `reapConcerns` (retention) is W05b Task 10's, not this file's yet.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  CONCERN_FEEDBACK_NOTE_MAX,
  CONCERN_PATTERN_EVIDENCE_KEY,
  LIVE_CONCERN_STATUSES,
  type Concern,
  type ConcernRecipientState,
  type ConcernSeverity,
  type ConcernStatus,
  type ConcernSubject,
} from '@breeze/shared';
import { isPgUniqueViolation, pgErrorConstraint } from '@breeze/shared/pgErrors';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withDbTransaction } from '../../db';
import { wispConcernRecipients, wispConcerns, type WispConcernRecipientRow, type WispConcernRow } from '../../db/schema/wispConcerns';
import { wispGrants } from '../../db/schema/wisp';
import { captureException } from '../sentry';
import {
  CeilingViolationError,
  GrantInactiveError,
  inSystemContext,
  resolveGrantCeiling,
  type GrantCeiling,
} from './grantAuthority';
import { rememberForGrant } from './memoryBroker';
import { incWispConcern } from '../wispMetrics';

export type { ConcernSubject, ConcernSeverity, ConcernStatus, Concern } from '@breeze/shared';

/** A recipient operation named a concern that does not exist. */
export class ConcernNotFoundError extends Error {
  readonly code = 'concern_not_found' as const;
  constructor(public readonly concernId: string) {
    super(`Wisp concern ${concernId} not found`);
    this.name = 'ConcernNotFoundError';
  }
}

/**
 * A signature-keyed insert found its SUBJECT held by a different live concern
 * (one without its signature). The two are not the same concern, so the
 * holder's id is never handed back as if it were (#10386: the readiness note
 * overwrote a model-raised HIGH org concern that way). The caller decides.
 */
export class ConcernSubjectHeldError extends Error {
  readonly code = 'concern_subject_held' as const;
  constructor(public readonly signature: string, public readonly heldByConcernId: string) {
    super(`Wisp concern subject is held by live concern ${heldByConcernId}, which does not carry signature ${signature}`);
    this.name = 'ConcernSubjectHeldError';
  }
}

const LIVE = sql`status IN ('open','snoozed')`;
const LIVE_WITH_SIGNATURE = sql`status IN ('open','snoozed') AND signature IS NOT NULL`;
const LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Nudge discipline (spec §7.4)
// ---------------------------------------------------------------------------

/** Minutes to wait after the Nth nudge (index = nudges already sent); the last entry repeats. */
const BACKOFF_MINUTES = [30, 60, 120, 1440] as const;

export function nextBackoff(nudgeCount: number): number {
  const i = Math.min(Math.max(Math.trunc(nudgeCount), 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[i]!;
}

/** SQL mirror of nextBackoff over a nudge-count expression, generated from the same table. */
function backoffMinutesSql(count: SQL): SQL {
  const whens = BACKOFF_MINUTES.slice(0, -1).map((m, i) => `WHEN ${i} THEN ${m}`).join(' ');
  return sql`(CASE GREATEST(${count}, 0) ${sql.raw(whens)} ELSE ${sql.raw(String(BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]))} END)`;
}

/** ≥ 2 nudges since the last answer: the concern rides the digest only. */
export function isDigestOnly(state: { nudgeCount: number; answeredAt: Date | null; lastNudgedAt: Date | null }): boolean {
  if (state.nudgeCount < 2) return false;
  const answeredSinceLastNudge = state.answeredAt !== null
    && (state.lastNudgedAt === null || state.answeredAt.getTime() >= state.lastNudgedAt.getTime());
  return !answeredSinceLastNudge;
}

// ---------------------------------------------------------------------------
// Concern writes
// ---------------------------------------------------------------------------

type UpsertConcernInput = {
  partnerId: string;
  orgId: string | null;
  subject: ConcernSubject;
  summary: string;
  severity: ConcernSeverity;
  evidence: Record<string, unknown>;
  raisedByGrantId?: string | null;
  lastAssessedRunId?: string | null;
  signature?: string | null;
  childConcernIds?: string[];
  /**
   * #11426: the normalised pattern key (`normalizeConcernPattern`) the
   * same-org rollup groups by. Stored as `evidence.pattern`, NOT as the
   * signature: the live-signature index is one live row per (partner,
   * signature), so N devices sharing a signature would collapse into one.
   */
  pattern?: string | null;
};

async function findLiveBySignature(partnerId: string, signature: string): Promise<string | null> {
  const [row] = await db.select({ id: wispConcerns.id }).from(wispConcerns)
    .where(and(
      eq(wispConcerns.partnerId, partnerId),
      eq(wispConcerns.signature, signature),
      inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
    ))
    .limit(1);
  return row?.id ?? null;
}

async function findLiveBySubject(partnerId: string, orgId: string | null, subject: ConcernSubject): Promise<string | null> {
  const [row] = await db.select({ id: wispConcerns.id }).from(wispConcerns)
    .where(and(
      eq(wispConcerns.partnerId, partnerId),
      orgId === null ? isNull(wispConcerns.orgId) : eq(wispConcerns.orgId, orgId),
      eq(wispConcerns.subjectKind, subject.kind),
      eq(wispConcerns.subjectId, subject.id),
      inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
    ))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Insert a concern unless a live one already holds it. The existing live row
 * is returned with `created: false` and is NOT touched — in particular a
 * snooze survives a re-raise (Review Focus 5).
 *
 * "Already holds it" is keyed by the insert's identity: the subject for an
 * unsigned concern, the signature for a signed one. A signed insert whose
 * subject is held by a live concern with another (or no) signature throws
 * `ConcernSubjectHeldError` instead (#10386).
 */
const LIVE_INDEXES = new Set(['wisp_concerns_live_subject_uq', 'wisp_concerns_live_signature_uq']);

export async function upsertConcern(input: UpsertConcernInput): Promise<{ id: string; created: boolean }> {
  const signature = input.signature ?? null;
  const values = {
    partnerId: input.partnerId,
    orgId: input.orgId,
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    summary: input.summary.trim(),
    severity: input.severity,
    evidence: input.pattern ? { ...input.evidence, [CONCERN_PATTERN_EVIDENCE_KEY]: input.pattern } : input.evidence,
    signature,
    childConcernIds: input.childConcernIds ?? [],
    raisedByGrantId: input.raisedByGrantId ?? null,
    lastAssessedRunId: input.lastAssessedRunId ?? null,
  };
  // The arbiter predicate must equal the partial index's, or Postgres refuses
  // the statement (42P10) at plan time.
  const conflict = signature !== null
    ? { target: [wispConcerns.partnerId, wispConcerns.signature], where: LIVE_WITH_SIGNATURE }
    : { target: [wispConcerns.partnerId, wispConcerns.orgId, wispConcerns.subjectKind, wispConcerns.subjectId], where: LIVE };

  return inSystemContext(async () => {
    // Two attempts: a live row seen by the conflict but resolved before our
    // select leaves nothing to return, and the retry then inserts.
    for (let attempt = 0; attempt < 2; attempt++) {
      let inserted: Array<{ id: string }> = [];
      try {
        // Savepoint: a unique violation on the OTHER live index (ON CONFLICT
        // names one arbiter) must not poison an ambient transaction.
        inserted = await withDbTransaction(() =>
          db.insert(wispConcerns).values(values).onConflictDoNothing(conflict).returning({ id: wispConcerns.id }));
      } catch (err) {
        // Only the two live indexes resolve to "already live"; any other
        // unique violation is a real bug and must surface.
        if (!isPgUniqueViolation(err) || !LIVE_INDEXES.has(pgErrorConstraint(err) ?? '')) throw err;
      }
      if (inserted[0]) {
        incWispConcern('opened');
        return { id: inserted[0].id, created: true };
      }

      const existing = signature !== null
        ? await findLiveBySignature(input.partnerId, signature)
        : await findLiveBySubject(input.partnerId, input.orgId, input.subject);
      if (existing) {
        incWispConcern('updated');
        return { id: existing, created: false };
      }
      if (signature !== null) {
        // Not ours by signature: a subject-index violation means another
        // concern holds the subject. Nothing live there either = it was
        // resolved between the violation and this read; retry the insert.
        const holder = await findLiveBySubject(input.partnerId, input.orgId, input.subject);
        if (holder) throw new ConcernSubjectHeldError(signature, holder);
      }
    }
    throw new Error('upsertConcern: the live concern vanished twice between conflict and read');
  });
}

/**
 * #11426: stamp `evidence.pattern` on a LIVE concern a re-raise found already
 * open (upsertConcern hands it back untouched). Only that key changes:
 * status, snooze and `updated_at` stay as they were. No-op when the key is
 * already this pattern, and on a concern closed meanwhile.
 */
export async function setConcernPattern(id: string, pattern: string): Promise<void> {
  await inSystemContext(async () => {
    await db.update(wispConcerns)
      .set({ evidence: sql`${wispConcerns.evidence} || jsonb_build_object(${CONCERN_PATTERN_EVIDENCE_KEY}::text, ${pattern}::text)` })
      .where(and(
        eq(wispConcerns.id, id),
        inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
        sql`${wispConcerns.evidence} ->> ${CONCERN_PATTERN_EVIDENCE_KEY}::text IS DISTINCT FROM ${pattern}::text`,
      ));
  });
}

/**
 * Resolve the live concern holding `signature` for the partner, if any (system
 * automation closing its own readiness concern; no memory block is written).
 * Idempotent: nothing live → `{ resolved: false }`.
 */
export async function resolveConcernBySignature(
  partnerId: string,
  signature: string,
  outcome: string,
): Promise<{ resolved: boolean }> {
  const id = await inSystemContext(() => findLiveBySignature(partnerId, signature));
  if (!id) return { resolved: false };
  const { resolved } = await resolveConcern(id, {}, outcome);
  return { resolved };
}

/**
 * Patch the given fields of a LIVE concern; evidence is replaced, not merged.
 * No-op on an unknown id and on a concern that was resolved or dismissed
 * meanwhile (a run that read it open must not bump a closed one — the routes'
 * `concern_not_live` rule, W06 carry-over).
 */
export async function updateConcern(
  id: string,
  patch: { summary?: string; severity?: ConcernSeverity; evidence?: Record<string, unknown>; lastAssessedRunId?: string | null; childConcernIds?: string[] },
): Promise<void> {
  const set: PgUpdateSetSource<typeof wispConcerns> = { updatedAt: sql`now()` };
  if (patch.summary !== undefined) set.summary = patch.summary.trim();
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.evidence !== undefined) set.evidence = patch.evidence;
  if (patch.lastAssessedRunId !== undefined) set.lastAssessedRunId = patch.lastAssessedRunId;
  if (patch.childConcernIds !== undefined) set.childConcernIds = patch.childConcernIds;
  await inSystemContext(async () => {
    await db.update(wispConcerns).set(set)
      .where(and(eq(wispConcerns.id, id), inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES])));
  });
}

/**
 * Resolve a live concern (idempotent: a resolved/dismissed one is left alone).
 * With `by.grantId`, the outcome is remembered as a `concern_outcome` block
 * AFTER the resolution is written; the memory write never undoes it. A real
 * transition then sends the resolved-nudge follow-up (#11427), best-effort.
 */
export async function resolveConcern(
  id: string,
  by: { grantId?: string; userId?: string },
  outcome: string,
): Promise<{ resolved: boolean; remembered: boolean }> {
  const resolved = await inSystemContext(async () => {
    const [row] = await db.update(wispConcerns)
      .set({
        status: 'resolved',
        outcome,
        resolvedAt: sql`now()`,
        resolvedByUserId: by.userId ?? null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(wispConcerns.id, id), inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES])))
      .returning({
        id: wispConcerns.id,
        orgId: wispConcerns.orgId,
        subjectKind: wispConcerns.subjectKind,
        subjectId: wispConcerns.subjectId,
        summary: wispConcerns.summary,
        severity: wispConcerns.severity,
      });
    return row ?? null;
  });
  if (!resolved) return { resolved: false, remembered: false };
  incWispConcern('resolved');
  const remembered = by.grantId ? await rememberOutcome(id, by.grantId, resolved, outcome) : false;
  await followUpResolvedNudge(id);
  return { resolved: true, remembered };
}

type ResolvedConcernRow = {
  id: string; orgId: string | null; subjectKind: string; subjectId: string; summary: string; severity: ConcernSeverity;
};

/**
 * Remember a grant's resolution as a `concern_outcome` block, AFTER the
 * resolution is written; the memory write never undoes it. false = not
 * remembered (the grant cannot author memory right now, or the write failed).
 */
async function rememberOutcome(id: string, grantId: string, resolved: ResolvedConcernRow, outcome: string): Promise<boolean> {
  const remember = async () => {
    const [grant] = await inSystemContext(() =>
      db.select({ currentRevisionId: wispGrants.currentRevisionId }).from(wispGrants).where(eq(wispGrants.id, grantId)).limit(1));
    // No pinned revision = no ceiling to author under; nothing to remember.
    if (!grant?.currentRevisionId) return false;
    const ceiling = await resolveGrantCeiling(grantId, grant.currentRevisionId);
    await rememberForGrant(ceiling, {
      owner: resolved.orgId ? { kind: 'org', orgId: resolved.orgId } : { kind: 'partner' },
      blockType: 'concern_outcome',
      subjectKey: `concern:${resolved.subjectKind}:${resolved.subjectId}`,
      content: { summary: resolved.summary, outcome, severity: resolved.severity, resolvedBy: 'wisp' },
      confidence: 'medium',
    });
    return true;
  };
  try {
    // Inside a caller's system transaction, isolate the memory write in a
    // savepoint so a failure there cannot poison the caller's commit.
    return getCurrentDbAccessContext()?.scope === 'system'
      ? await withDbTransaction(remember)
      : await remember();
  } catch (err) {
    // The grant cannot author memory right now (paused / revoked / grantor
    // lost standing, or the owner fell outside its ceiling). The resolution
    // stands; the outcome simply is not remembered.
    if (!(err instanceof GrantInactiveError || err instanceof CeilingViolationError)) {
      captureException(err, undefined, { concernId: id, grantId, op: 'wisp.concerns.resolve.remember' });
    }
    return false;
  }
}

/**
 * #11427: a concern Wisp nudged someone about just closed — tell each nudged
 * thread that no action is needed (`nudgeResolved.ts`; a no-op for a concern
 * nobody was nudged about). Every resolve path calls this, but only a COMMITTED
 * resolution is followed up: inside a caller's system transaction (admission's
 * readiness close) the resolution is not committed yet, a reader on another
 * connection would still see the concern live, and a failed read on the
 * caller's connection would abort its transaction and roll the resolution back
 * — so that case is skipped, with a trace. Otherwise the follow-up runs outside
 * every DB context. Best-effort: logged, never thrown, so the resolution always
 * stands. Lazy import: nudgeResolved → notifyUser → concerns would otherwise be
 * an import cycle.
 */
async function followUpResolvedNudge(id: string): Promise<void> {
  if (getCurrentDbAccessContext()?.scope === 'system') {
    console.warn('[wisp.concerns] resolved inside a caller transaction; no resolved-nudge follow-up', { concernId: id });
    return;
  }
  try {
    const { notifyNudgeResolved } = await import('./nudgeResolved');
    await runOutsideDbContext(() => notifyNudgeResolved(id));
  } catch (err) {
    console.error('[wisp.concerns] resolved-nudge follow-up failed; the resolution stands', { concernId: id, err });
    captureException(err, undefined, { concernId: id, op: 'wisp.concerns.resolve.nudgeResolved' });
  }
}

/** The outcome recorded on a concern closed because its linked alert resolved. */
export const ALERT_RESOLVED_OUTCOME = 'alert_resolved';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live concerns closed per resolved alert; any beyond it stay open for the model (or a repeat event) to close. */
const ALERT_RESOLVE_LIMIT = 50;

/**
 * #11427: the alert a concern was raised about resolved — close the concern
 * deterministically (no model call), so the next assessment reads it closed.
 * Matches live concerns IN THE ALERT'S ORG whose evidence names the alert as
 * `alertId` or `rebootAlertId` (model-written evidence keys, as seen on prod
 * concerns; nothing validates them). The org pin is the isolation: a concern
 * of another org is never read, whatever its evidence says. Outcome
 * `alert_resolved`, no grant (nothing is remembered as Wisp-authored memory).
 * Idempotent: a concern already closed is not resolved twice or counted. One
 * concern that fails to resolve is reported and never stops the rest. Returns
 * how many it resolved.
 */
export async function resolveConcernsForAlert(alertId: string, orgId: string): Promise<{ resolved: number }> {
  if (!UUID_RE.test(alertId) || !UUID_RE.test(orgId)) return { resolved: 0 };
  const rows = await inSystemContext(() => db.select({ id: wispConcerns.id }).from(wispConcerns)
    .where(and(
      eq(wispConcerns.orgId, orgId),
      inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
      or(
        sql`${wispConcerns.evidence}->>'alertId' = ${alertId}`,
        sql`${wispConcerns.evidence}->>'rebootAlertId' = ${alertId}`,
      ),
    ))
    .limit(ALERT_RESOLVE_LIMIT));
  let resolved = 0;
  for (const { id } of rows) {
    try {
      if ((await resolveConcern(id, {}, ALERT_RESOLVED_OUTCOME)).resolved) resolved += 1;
    } catch (err) {
      console.error('[wisp.concerns] closing a concern of a resolved alert failed', { concernId: id, alertId, err });
      captureException(err, undefined, { concernId: id, alertId, op: 'wisp.concerns.resolveForAlert' });
    }
  }
  return { resolved };
}

// ---------------------------------------------------------------------------
// Recipients (per-grant state)
// ---------------------------------------------------------------------------

type RecipientSet = Partial<Pick<typeof wispConcernRecipients.$inferInsert,
  'nudgeCount' | 'lastNudgedAt' | 'nextEligibleNudgeAt' | 'snoozedUntil' | 'dismissedAt' | 'answeredAt' | 'feedback' | 'feedbackAt' | 'feedbackNote'>>;

/** Load the concern (source of truth for partner/org) or throw ConcernNotFoundError. Must run in system context. */
async function loadConcernTenancy(concernId: string): Promise<{ partnerId: string; orgId: string | null }> {
  const [c] = await db.select({ partnerId: wispConcerns.partnerId, orgId: wispConcerns.orgId })
    .from(wispConcerns).where(eq(wispConcerns.id, concernId)).limit(1);
  if (!c) throw new ConcernNotFoundError(concernId);
  return c;
}

/** Create-or-update the (concern, grant) recipient row. Must run in system context. */
async function upsertRecipient(concernId: string, grantId: string, set: RecipientSet): Promise<void> {
  const tenancy = await loadConcernTenancy(concernId);
  await db.insert(wispConcernRecipients)
    .values({ concernId, grantId, partnerId: tenancy.partnerId, orgId: tenancy.orgId, ...set })
    .onConflictDoUpdate({
      target: [wispConcernRecipients.concernId, wispConcernRecipients.grantId],
      set: { ...set, updatedAt: sql`now()` },
    });
}

/**
 * Serialise recipient-aggregate transitions on one concern: without the row
 * lock, two recipients dismissing (or snoozing) at once each still see the
 * other's row as open under READ COMMITTED and neither closes the concern.
 * Must run inside the caller's system transaction. Throws ConcernNotFoundError.
 */
async function lockConcern(id: string): Promise<void> {
  const [row] = await db.select({ id: wispConcerns.id }).from(wispConcerns)
    .where(eq(wispConcerns.id, id)).for('update').limit(1);
  if (!row) throw new ConcernNotFoundError(id);
}

/** This grant dismissed the concern; the concern closes once every recipient has. */
export async function dismissConcern(id: string, by: { grantId: string; userId: string }): Promise<void> {
  const now = new Date();
  await inSystemContext(async () => {
    await lockConcern(id);
    await upsertRecipient(id, by.grantId, { dismissedAt: now, answeredAt: now });
    const closed = await db.update(wispConcerns)
      .set({ status: 'dismissed', updatedAt: sql`now()` })
      .where(and(
        eq(wispConcerns.id, id),
        inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
        sql`NOT EXISTS (SELECT 1 FROM wisp_concern_recipients r WHERE r.concern_id = ${wispConcerns.id} AND r.dismissed_at IS NULL)`,
      ))
      .returning({ id: wispConcerns.id });
    if (closed.length > 0) incWispConcern('dismissed');
  });
}

/** This grant snoozed the concern; the concern reads 'snoozed' while no recipient is open. */
export async function snoozeConcern(id: string, by: { grantId: string; userId: string }, until: Date): Promise<void> {
  const now = new Date();
  await inSystemContext(async () => {
    await lockConcern(id);
    await upsertRecipient(id, by.grantId, { snoozedUntil: until, answeredAt: now });
    const parked = await db.update(wispConcerns)
      .set({ status: 'snoozed', updatedAt: sql`now()` })
      .where(and(
        eq(wispConcerns.id, id),
        inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
        sql`NOT EXISTS (SELECT 1 FROM wisp_concern_recipients r WHERE r.concern_id = ${wispConcerns.id}
          AND r.dismissed_at IS NULL AND (r.snoozed_until IS NULL OR r.snoozed_until <= now()))`,
      ))
      .returning({ id: wispConcerns.id });
    if (parked.length > 0) incWispConcern('snoozed');
  });
}

export async function markAnswered(concernId: string, grantId: string, at: Date): Promise<void> {
  await inSystemContext(() => upsertRecipient(concernId, grantId, { nudgeCount: 0, answeredAt: at }));
}

/**
 * Count a nudge in ONE statement (no read-modify-write race):
 * next_eligible = at + nextBackoff(previous count), then nudge_count + 1.
 * The INSERT … SELECT copies partner/org from the concern; no row back means
 * the concern does not exist.
 */
export async function recordNudge(concernId: string, grantId: string, at: Date): Promise<{ nudgeCount: number; nextEligibleNudgeAt: Date }> {
  const atIso = at.toISOString();
  const rows = await inSystemContext(() => db.execute(sql`
    INSERT INTO wisp_concern_recipients
      (concern_id, partner_id, org_id, grant_id, nudge_count, last_nudged_at, next_eligible_nudge_at)
    SELECT c.id, c.partner_id, c.org_id, ${grantId}::uuid, 1, ${atIso}::timestamptz,
      ${atIso}::timestamptz + make_interval(mins => ${backoffMinutesSql(sql`0`)})
    FROM wisp_concerns c
    WHERE c.id = ${concernId}::uuid
    ON CONFLICT (concern_id, grant_id) DO UPDATE SET
      nudge_count = wisp_concern_recipients.nudge_count + 1,
      last_nudged_at = EXCLUDED.last_nudged_at,
      next_eligible_nudge_at = EXCLUDED.last_nudged_at
        + make_interval(mins => ${backoffMinutesSql(sql`wisp_concern_recipients.nudge_count`)}),
      updated_at = now()
    RETURNING nudge_count, next_eligible_nudge_at
  `));
  const row = (rows as unknown as Array<{ nudge_count: number | string; next_eligible_nudge_at: Date | string }>)[0];
  if (!row) throw new ConcernNotFoundError(concernId);
  return { nudgeCount: Number(row.nudge_count), nextEligibleNudgeAt: new Date(row.next_eligible_nudge_at) };
}

/** One-tap "useful / not useful" (w00 A34): an answer; not_useful also holds nudges off for 24 h. */
export async function recordFeedback(
  concernId: string,
  grantId: string,
  f: { useful: boolean; note?: string | null },
  at: Date = new Date(),
): Promise<void> {
  const note = f.note?.trim().slice(0, CONCERN_FEEDBACK_NOTE_MAX) || null;
  const set: RecipientSet = {
    feedback: f.useful ? 'useful' : 'not_useful',
    feedbackAt: at,
    feedbackNote: note,
    answeredAt: at,
    nudgeCount: 0,
  };
  if (!f.useful) set.nextEligibleNudgeAt = new Date(at.getTime() + 24 * 60 * 60_000);
  await inSystemContext(() => upsertRecipient(concernId, grantId, set));
}

export async function recipientState(concernId: string, grantId: string): Promise<{
  nudgeCount: number; nextEligibleNudgeAt: Date | null; snoozedUntil: Date | null; dismissedAt: Date | null;
}> {
  const [row] = await inSystemContext(() => db
    .select({
      nudgeCount: wispConcernRecipients.nudgeCount,
      nextEligibleNudgeAt: wispConcernRecipients.nextEligibleNudgeAt,
      snoozedUntil: wispConcernRecipients.snoozedUntil,
      dismissedAt: wispConcernRecipients.dismissedAt,
    })
    .from(wispConcernRecipients)
    .where(and(eq(wispConcernRecipients.concernId, concernId), eq(wispConcernRecipients.grantId, grantId)))
    .limit(1));
  return row ?? { nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null };
}

// ---------------------------------------------------------------------------
// Ceiling-filtered reads
// ---------------------------------------------------------------------------

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRecipientState(r: Pick<WispConcernRecipientRow,
  'nudgeCount' | 'lastNudgedAt' | 'nextEligibleNudgeAt' | 'snoozedUntil' | 'dismissedAt' | 'answeredAt' | 'feedback'>): ConcernRecipientState {
  return {
    nudgeCount: r.nudgeCount,
    lastNudgedAt: iso(r.lastNudgedAt),
    nextEligibleNudgeAt: iso(r.nextEligibleNudgeAt),
    snoozedUntil: iso(r.snoozedUntil),
    dismissedAt: iso(r.dismissedAt),
    answeredAt: iso(r.answeredAt),
    digestOnly: isDigestOnly({ nudgeCount: r.nudgeCount, answeredAt: r.answeredAt, lastNudgedAt: r.lastNudgedAt }),
    feedback: r.feedback ?? null,
  };
}

function toConcern(c: WispConcernRow, r: WispConcernRecipientRow | null): Concern {
  const evidence = (c.evidence ?? {}) as Record<string, unknown>;
  const intent = evidence.approvalIntentId;
  return {
    id: c.id,
    partnerId: c.partnerId,
    orgId: c.orgId,
    subject: { kind: c.subjectKind, id: c.subjectId },
    summary: c.summary,
    severity: c.severity,
    status: c.status,
    evidence,
    outcome: c.outcome,
    signature: c.signature,
    childConcernIds: c.childConcernIds ?? [],
    approvalIntentId: typeof intent === 'string' ? intent : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    resolvedAt: iso(c.resolvedAt),
    ...(r ? { recipient: toRecipientState(r) } : {}),
  };
}

/**
 * The ceiling's visibility predicate: the anchor partner, orgs inside the
 * ceiling, and partner-level (org_id NULL) rows only for a partner-wide grant
 * whose grantor still reaches the whole partner. null = nothing visible.
 */
/**
 * Orgs whose concerns this ceiling may read. A concern's subject carries no
 * site, so a site-restricted ceiling (ceiling-wide, or the org's own
 * membership term) cannot be shown to cover it: those orgs read nothing —
 * fail closed, the same way assertWithinCeiling refuses an org-only check
 * under a site restriction (so such a grant cannot raise one either).
 */
function readableOrgIds(ceiling: GrantCeiling): Set<string> {
  if (ceiling.siteIds !== null) return new Set();
  return new Set([...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null));
}

function visibilityWhere(ceiling: GrantCeiling, orgId?: string): SQL | null {
  const readable = readableOrgIds(ceiling);
  if (orgId !== undefined) {
    if (!readable.has(orgId)) return null;
    return and(eq(wispConcerns.partnerId, ceiling.partnerId), eq(wispConcerns.orgId, orgId))!;
  }
  const orgIds = [...readable];
  const partnerLevel = ceiling.scopeOrgId === null && ceiling.partnerWide && ceiling.siteIds === null;
  const branches: SQL[] = [];
  if (orgIds.length > 0) branches.push(inArray(wispConcerns.orgId, orgIds));
  if (partnerLevel) branches.push(isNull(wispConcerns.orgId));
  if (branches.length === 0) return null;
  return and(eq(wispConcerns.partnerId, ceiling.partnerId), branches.length === 1 ? branches[0]! : or(...branches)!)!;
}

const severityRank = sql`CASE ${wispConcerns.severity} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`;

async function selectWithRecipient(ceiling: GrantCeiling, where: SQL, limit: number): Promise<Concern[]> {
  const rows = await inSystemContext(() => db
    .select({ c: wispConcerns, r: wispConcernRecipients })
    .from(wispConcerns)
    .leftJoin(wispConcernRecipients, and(
      eq(wispConcernRecipients.concernId, wispConcerns.id),
      eq(wispConcernRecipients.grantId, ceiling.grantId),
    ))
    .where(where)
    .orderBy(severityRank, desc(wispConcerns.updatedAt))
    .limit(limit));
  return rows.map((row) => toConcern(row.c, row.r));
}

export async function listConcernsForCeiling(ceiling: GrantCeiling, f: { status?: ConcernStatus[]; orgId?: string } = {}): Promise<Concern[]> {
  const visible = visibilityWhere(ceiling, f.orgId);
  if (!visible) return [];
  const statuses = f.status ?? [...LIVE_CONCERN_STATUSES];
  if (statuses.length === 0) return [];
  return selectWithRecipient(ceiling, and(visible, inArray(wispConcerns.status, statuses))!, LIST_LIMIT);
}

/** One concern under the ceiling, or null when it does not exist OR is not visible (existence-neutral). */
export async function getConcernForCeiling(ceiling: GrantCeiling, id: string): Promise<Concern | null> {
  const visible = visibilityWhere(ceiling);
  if (!visible) return null;
  const [concern] = await selectWithRecipient(ceiling, and(visible, eq(wispConcerns.id, id))!, 1);
  return concern ?? null;
}

/**
 * #10392: true only when the concern is visible to this ceiling, still live,
 * and was raised by THIS grant (a chat raise_concern or this grant's own
 * assessment). The chat gate uses it to let a snooze of Wisp's own loose ends
 * run without an approval card; a concern raised by a person, another grant,
 * or nobody (grant deleted → NULL) keeps the card, because parking it changes
 * state other people see. (Resolve always keeps its card: it writes shared
 * concern_outcome memory — wisp/selfStateTools.ts.)
 */
export async function isLiveConcernRaisedByGrant(ceiling: GrantCeiling, id: string): Promise<boolean> {
  const visible = visibilityWhere(ceiling);
  if (!visible) return false;
  const [row] = await inSystemContext(() => db
    .select({ id: wispConcerns.id })
    .from(wispConcerns)
    .where(and(
      visible,
      eq(wispConcerns.id, id),
      eq(wispConcerns.raisedByGrantId, ceiling.grantId),
      inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
    ))
    .limit(1));
  return row !== undefined;
}
