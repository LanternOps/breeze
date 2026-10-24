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
  LIVE_CONCERN_STATUSES,
  type Concern,
  type ConcernRecipientState,
  type ConcernSeverity,
  type ConcernStatus,
  type ConcernSubject,
} from '@breeze/shared';
import { isPgUniqueViolation, pgErrorConstraint } from '@breeze/shared/pgErrors';
import { db, getCurrentDbAccessContext, withDbTransaction } from '../../db';
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

export type { ConcernSubject, ConcernSeverity, ConcernStatus, Concern } from '@breeze/shared';

/** A recipient operation named a concern that does not exist. */
export class ConcernNotFoundError extends Error {
  readonly code = 'concern_not_found' as const;
  constructor(public readonly concernId: string) {
    super(`Wisp concern ${concernId} not found`);
    this.name = 'ConcernNotFoundError';
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
 * Insert a concern unless a live one already holds the subject (or the
 * signature). The existing live row is returned with `created: false` and is
 * NOT touched — in particular a snooze survives a re-raise (Review Focus 5).
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
    evidence: input.evidence,
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
      if (inserted[0]) return { id: inserted[0].id, created: true };

      const existing = (signature !== null ? await findLiveBySignature(input.partnerId, signature) : null)
        ?? await findLiveBySubject(input.partnerId, input.orgId, input.subject);
      if (existing) return { id: existing, created: false };
    }
    throw new Error('upsertConcern: the live concern vanished twice between conflict and read');
  });
}

/** Patch the given fields; evidence is replaced, not merged. No-op on an unknown id. */
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
    await db.update(wispConcerns).set(set).where(eq(wispConcerns.id, id));
  });
}

/**
 * Resolve a live concern (idempotent: a resolved/dismissed one is left alone).
 * With `by.grantId`, the outcome is remembered as a `concern_outcome` block
 * AFTER the resolution is written; the memory write never undoes it.
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
  if (!by.grantId) return { resolved: true, remembered: false };

  const grantId = by.grantId;
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
    const remembered = getCurrentDbAccessContext()?.scope === 'system'
      ? await withDbTransaction(remember)
      : await remember();
    return { resolved: true, remembered };
  } catch (err) {
    // The grant cannot author memory right now (paused / revoked / grantor
    // lost standing, or the owner fell outside its ceiling). The resolution
    // stands; the outcome simply is not remembered.
    if (!(err instanceof GrantInactiveError || err instanceof CeilingViolationError)) {
      captureException(err, undefined, { concernId: id, grantId, op: 'wisp.concerns.resolve.remember' });
    }
    return { resolved: true, remembered: false };
  }
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
    await db.update(wispConcerns)
      .set({ status: 'dismissed', updatedAt: sql`now()` })
      .where(and(
        eq(wispConcerns.id, id),
        inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
        sql`NOT EXISTS (SELECT 1 FROM wisp_concern_recipients r WHERE r.concern_id = ${wispConcerns.id} AND r.dismissed_at IS NULL)`,
      ));
  });
}

/** This grant snoozed the concern; the concern reads 'snoozed' while no recipient is open. */
export async function snoozeConcern(id: string, by: { grantId: string; userId: string }, until: Date): Promise<void> {
  const now = new Date();
  await inSystemContext(async () => {
    await lockConcern(id);
    await upsertRecipient(id, by.grantId, { snoozedUntil: until, answeredAt: now });
    await db.update(wispConcerns)
      .set({ status: 'snoozed', updatedAt: sql`now()` })
      .where(and(
        eq(wispConcerns.id, id),
        inArray(wispConcerns.status, [...LIVE_CONCERN_STATUSES]),
        sql`NOT EXISTS (SELECT 1 FROM wisp_concern_recipients r WHERE r.concern_id = ${wispConcerns.id}
          AND r.dismissed_at IS NULL AND (r.snoozed_until IS NULL OR r.snoozed_until <= now()))`,
      ));
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
