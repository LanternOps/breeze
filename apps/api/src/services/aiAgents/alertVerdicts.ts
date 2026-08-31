// apps/api/src/services/aiAgents/alertVerdicts.ts
/**
 * Phase 2 wave P2-1 (alert verdicts) — Task 8. Persists the `AlertVerdictOutcome`
 * a `verdict`-profile run produced (`runLoop.ts`'s `finalizeVerdict`), converts an
 * optional `suggestedAction` into a Tier-2 `supervised` `manage_alerts`
 * action-intent for the `ai_agent` principal (Task 3's `createActionIntent`
 * contract), and provides the safe `AiAgentRunAlertVerdictDto` projection
 * `runTrace.ts` puts on the wire.
 *
 * `persistAlertVerdict` is called from the background run loop (no ambient
 * request context), so its own reads/writes run inside a local system db
 * context — same duplicated-per-file `inSystemDbContext` pattern as every
 * other file in this directory (agentCircuit.ts, fixWatch.ts, runService.ts,
 * …).
 *
 * `createActionIntent` is called OUTSIDE that wrapper, deliberately (review
 * round 1 correction). Nesting `inSystemDbContext` inside an ALREADY-system
 * context is not itself the hazard — `withDbAccessContext` early-returns
 * `fn()` directly when a context is already active, so it would just share
 * this file's own transaction, not open a second one. The actual hazard is
 * that `createActionIntent` internally calls `runOutsideDbContext(...)` at
 * several points (its best-effort push-token/notification paths — see
 * `intentService.ts`) specifically to ESCAPE whatever ambient context is
 * active, INCLUDING one this file opened, before opening its OWN fresh
 * system-scoped transaction for that inner work. That inner transaction is
 * a genuinely second pooled connection, held WHILE this file's own
 * transaction is still open (the outer async chain is still awaiting
 * completion) — for however long that inner call takes. Calling
 * `createActionIntent` bare avoids ever holding two connections at once for
 * this path; this mirrors `runLoop.ts`'s `recordProposal`, which calls
 * `createActionIntent` bare for the same reason.
 *
 * `latestVerdictsForAlerts` / `latestVerdictForGroup` / `recordVerdictFeedback`
 * are request-path helpers (explicit `orgId`/RLS-scoped `id` lookups) and are
 * NOT wrapped in a system context — they run inside the caller's own
 * `withDbAccessContext`, same as every other read in `routes/aiAgents.ts`.
 *
 * Write ordering (review round 2, Minor 4): the verdict row is written
 * (with `suggestedIntentId: null`) and superseded BEFORE `createActionIntent`
 * is ever called; the intent id is linked back with a separate `UPDATE`
 * afterward, only when one was actually created. A crash/throw between the
 * write and that final `UPDATE` leaves a verdict row with no linked intent
 * (a `NULL` suggestedIntentId is a valid, already-handled state — see
 * `projectAlertVerdict`) rather than a live, human-approvable intent nobody
 * can find because the verdict row it belongs to was never written.
 *
 * Write ordering, part 2 (carry-in C, P2-1 Task 14 — live-verdict partial
 * unique): `ai_alert_verdicts_live_{alert,group}_uq` (migrations/
 * 2026-09-22-ai-alert-verdicts-live-unique.sql) allows at most one LIVE
 * (`superseded_by IS NULL`) row per target. The original INSERT-then-
 * supersede ordering above would ALWAYS violate that index for the instant
 * both rows are live at once, so the id is generated CLIENT-SIDE
 * (`randomUUID()`) and the two statements are flipped: supersede the
 * existing live row(s) to point `superseded_by` at the not-yet-inserted id
 * FIRST, then INSERT the new row with that id. The self-referencing
 * `superseded_by` FK is `DEFERRABLE INITIALLY DEFERRED` (same migration)
 * specifically so the UPDATE naming a not-yet-existent id does not fail
 * immediately — it is checked once, at COMMIT. Both statements already run
 * inside ONE transaction: `inSystemDbContext` / `withSystemDbAccessContext`
 * wraps its callback in `baseDb.transaction(...)` (db/index.ts) — no
 * additional `db.transaction` call is needed here.
 *
 * A concurrent second run targeting the same alert/group either has its own
 * UPDATE match zero rows (this transaction's commit already flipped
 * `superseded_by` away from `NULL`) and then 23505s on its own INSERT, or
 * commits first and makes THIS transaction's INSERT the one that 23505s.
 * Either way one of the two racing writers loses; `persistAlertVerdict`
 * catches that 23505 (via `isPgUniqueViolation`, scoped to the specific
 * partial-unique constraint for the target kind — never a bare `error.code`
 * check, which would also swallow an unrelated conflict), re-reads the
 * winner's live row, and returns `suggestionReason: 'superseded_concurrently'`
 * — the loser's verdict is dropped, not retried, and no intent is attempted.
 * If that re-read finds no live row, it throws rather than fabricating an
 * id (MINOR 3, fix round 1) — with the partial unique in place a 23505 on
 * this constraint guarantees a live row exists, so a missing one means the
 * invariant broke and an honest failure beats a silently wrong verdictId.
 *
 * MINOR 4 (fix round 1) — this recovery mechanism REQUIRES
 * `persistAlertVerdict` to never be called from inside an ambient DB
 * context; see the precondition on the function's own docstring below for
 * why (a shared ambient transaction would abort on the 23505 and the
 * recovery SELECT would then fail with 25P02 instead of finding the row).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type {
  AlertAiVerdictSummaryDto, AlertVerdictOutcome, AlertVerdictSuggestionDisposition,
  AlertVerdictSuggestionReason, AiAgentRunAlertVerdictDto,
} from '@breeze/shared';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { aiAlertVerdicts, alertCorrelationMembers, alerts, type AiAlertVerdictRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { createActionIntent } from '../actionIntents/intentService';
import { isToolAllowlisted } from './toolAllowlist';

/**
 * `ai_alert_verdicts_live_{alert,group}_uq` (migrations/2026-09-22-ai-alert-
 * verdicts-live-unique.sql) — the partial-unique constraint name the write
 * ordering in `persistAlertVerdict` races against, keyed by target kind.
 * Passed to `isPgUniqueViolation` so a 23505 on some UNRELATED constraint
 * (there is no other unique index on this table today, but this stays
 * precise rather than a bare `error.code === '23505'` check) is never
 * mistaken for the concurrent-supersede race this handles.
 */
function liveVerdictUniqueConstraintName(correlationGroupId: string | null): string {
  return correlationGroupId ? 'ai_alert_verdicts_live_group_uq' : 'ai_alert_verdicts_live_alert_uq';
}

/**
 * Same skip-if-already-system shape as every other file in this directory
 * (see runLoop.ts's `inSystemDbContext` for the full rationale): a bare
 * system wrapper is a no-op inside an ambient request context, and
 * re-entering from an already-system context would take a SECOND pooled
 * connection while the first is still held.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Phase 2 wave P2-1, review round 1 (IMPORTANT 2). The shape stored on
 * `AgentRunOutcome.alertVerdictIntent` (runLoop.ts) — re-exported here so
 * `AgentRunOutcome` can reference it without this file importing anything
 * from `runLoop.ts` (which already imports FROM this file; importing back
 * would be circular). `reason` absent means `disposition ===
 * 'intent_created'` — nothing to explain.
 */
export interface AlertVerdictIntentInfo {
  disposition: AlertVerdictSuggestionDisposition;
  reason?: AlertVerdictSuggestionReason;
}

/**
 * Safe projection of one `ai_alert_verdicts` row (or the in-flight
 * `AlertVerdictOutcome`, same shape) for `GET /ai/agents/runs/:runId`'s
 * detail DTO. No raw tool args, no `deviceId`/`suppressDuration` off
 * `suggestedAction` — display fields only, matching
 * `AiAgentRunAlertVerdictDto`'s leak-impossible-by-construction contract
 * (@breeze/shared's aiAgentRuns.ts).
 *
 * `intentInfo` (review round 1, IMPORTANT 2) is the disposition of the
 * suggestion's Tier-2 intent attempt, stored separately on
 * `AgentRunOutcome.alertVerdictIntent` — passed in rather than embedded on
 * `AlertVerdictOutcome` itself, since the model never produces it (it's
 * this file's own bookkeeping, added after the verdict tool call).
 */
export function projectAlertVerdict(
  v: AlertVerdictOutcome | undefined,
  intentInfo?: AlertVerdictIntentInfo,
): AiAgentRunAlertVerdictDto | null {
  if (!v) return null;
  return {
    classification: v.classification,
    confidence: v.confidence,
    rationale: v.rationale,
    patternKind: v.pattern?.kind ?? null,
    evidenceAlertIds: v.pattern?.evidenceAlertIds ?? [],
    suggestedAction: v.suggestedAction
      ? {
        tool: 'manage_alerts',
        action: v.suggestedAction.action,
        disposition: intentInfo?.disposition ?? 'not_created',
        reason: intentInfo?.reason ?? null,
      }
      : null,
  };
}

/**
 * A suggested mutation may only target the alert the run itself evaluated,
 * or (for a group-scoped run) an alert that is an actual member of that
 * correlation group — never an arbitrary alert id the model happened to
 * name. `run.alertId === alertId` short-circuits without a query for the
 * (overwhelmingly common) single-alert-run case.
 */
async function suggestionTargetsRun(
  run: { orgId: string; alertId: string | null; correlationGroupId: string | null },
  alertId: string,
): Promise<boolean> {
  if (run.alertId === alertId) return true;
  if (!run.correlationGroupId) return false;
  const groupId = run.correlationGroupId;
  return inSystemDbContext(async () => {
    const [m] = await db.select({ id: alertCorrelationMembers.id }).from(alertCorrelationMembers)
      .where(and(
        eq(alertCorrelationMembers.orgId, run.orgId),
        eq(alertCorrelationMembers.groupId, groupId),
        eq(alertCorrelationMembers.alertId, alertId),
      )).limit(1);
    return Boolean(m);
  });
}

export interface PersistAlertVerdictResult {
  verdictId: string;
  intentId: string | null;
  /** Review round 1, IMPORTANT 2 — see `AlertVerdictIntentInfo`. Always
   *  present (unlike the optional field on `AgentRunOutcome`); the caller
   *  decides whether there was even a `suggestedAction` to report on. */
  suggestionDisposition: AlertVerdictSuggestionDisposition;
  suggestionReason?: AlertVerdictSuggestionReason;
}

/**
 * MINOR 4 (fix round 1) — PRECONDITION: must NOT be called from inside an
 * ambient DB context (i.e. from inside an already-open `withDbAccessContext`
 * / `withSystemDbAccessContext` transaction). `finalizeVerdict` (runLoop.ts)
 * satisfies this today — it runs from the background run loop, which holds
 * no ambient context of its own.
 *
 * Why this matters: the 23505 concurrent-supersede recovery (see the file
 * header's "Write ordering, part 2") relies on `inSystemDbContext` opening
 * its OWN fresh transaction on each call. If a caller already held an
 * ambient system-scope context, `inSystemDbContext` would skip opening a new
 * transaction (it detects the existing one and just runs `fn()` directly —
 * see its own docstring) and the failed INSERT's 23505 would abort THAT
 * shared transaction. Every subsequent statement in it — including the
 * recovery SELECT, which itself calls `inSystemDbContext` again and would
 * reuse the SAME now-aborted transaction — would then fail with `25P02`
 * ("current transaction is aborted") instead of returning the winning row,
 * turning a handled race into an unhandled one.
 */
export async function persistAlertVerdict(
  run: {
    id: string; orgId: string; alertId: string | null;
    correlationGroupId: string | null; deviceId: string | null;
    /**
     * Review round 2 (IMPORTANT 1) — the run's own effective
     * `toolAllowlist`, read once by the caller off the stored
     * `policySnapshot.effective.toolAllowlist` (`runLoop.ts`'s
     * `finalizeVerdict` — the run row is already loaded there, so this is
     * never a second query). Gates whether a suggested mutation may become
     * an intent at all: RELEASE time (`agentReleaseAuthority.ts`) re-runs
     * `checkAgentGuardrails` with this SAME effective allowlist and the
     * RUN's own `deviceId`, so an approved intent whose tool the agent
     * never allowlisted — or whose target is on another device — is
     * terminally denied there. Checking the identical authority at
     * CREATION means a human is never asked to approve something that
     * cannot release.
     */
    toolAllowlist: string[];
  },
  verdict: AlertVerdictOutcome,
  agentAuth: AuthContext,
): Promise<PersistAlertVerdictResult> {
  let suggestionDisposition: AlertVerdictSuggestionDisposition = 'not_created';
  let suggestionReason: AlertVerdictSuggestionReason | undefined;
  const suggestion = verdict.suggestedAction;

  // Resolved ONLY when every refusal gate below is cleared — the single
  // condition that decides whether `createActionIntent` is even attempted,
  // further down, AFTER the verdict row is written (Minor 4).
  let targetDeviceId: string | null | undefined;
  let canAttemptIntent = false;

  if (suggestion) {
    // Confidence floor mirrors the guardrail spirit elsewhere in this wave:
    // a low-confidence classification may still be worth recording, but its
    // suggested mutation is not worth putting in front of a human approver.
    if (verdict.confidence < 0.8) {
      suggestionReason = 'low_confidence';
      console.warn('[alertVerdicts] suggestion refused — confidence below threshold', {
        runId: run.id, alertId: suggestion.alertId, confidence: verdict.confidence,
      });
    } else if (!(await suggestionTargetsRun(run, suggestion.alertId))) {
      suggestionReason = 'target_mismatch';
      console.warn('[alertVerdicts] suggestion refused — target mismatch (not the run alert or a group member)', {
        runId: run.id, alertId: suggestion.alertId,
      });
    } else {
      // `run.alertId === suggestion.alertId` is the overwhelmingly common
      // case (a single-alert run suggesting a mutation on its own alert):
      // skip the lookup entirely and use the device the run itself already
      // resolved. A correlation-group suggestion (a DIFFERENT alert than
      // the run's own) still needs the org-scoped lookup below — which also
      // doubles as the existence gate (minor fix: a suggestion naming a
      // real-but-deleted-since alert id must not reach `createActionIntent`
      // with an unresolved device).
      let targetFound = true;
      if (suggestion.alertId === run.alertId) {
        targetDeviceId = run.deviceId;
      } else {
        const [target] = await inSystemDbContext(() => db
          .select({ deviceId: alerts.deviceId })
          .from(alerts)
          .where(and(eq(alerts.id, suggestion.alertId), eq(alerts.orgId, run.orgId)))
          .limit(1));
        targetFound = Boolean(target);
        targetDeviceId = target?.deviceId;
      }

      if (!targetFound) {
        suggestionReason = 'alert_not_found';
        console.warn('[alertVerdicts] suggestion refused — target alert not found in org', {
          runId: run.id, alertId: suggestion.alertId,
        });
      } else if (!isToolAllowlisted(run.toolAllowlist, 'manage_alerts', suggestion.action)) {
        // Review round 2 (IMPORTANT 1a) — same matching rule as
        // `checkAgentGuardrails` (aiGuardrails.ts): a bare `manage_alerts`
        // entry OR the specific `manage_alerts:<action>` entry admits it.
        // Shared with `sweepFindings.ts`'s proposal gate via
        // `isToolAllowlisted` (P2-2 Task A7, review round 1) so the two
        // creation-time gates cannot drift apart from each other.
        suggestionReason = 'not_allowlisted';
        console.warn('[alertVerdicts] suggestion refused — manage_alerts not in the run\'s effective allowlist', {
          runId: run.id, alertId: suggestion.alertId, action: suggestion.action,
        });
      } else if (run.deviceId === null || targetDeviceId !== run.deviceId) {
        // Review round 2 (IMPORTANT 1b) — the target alert must be on the
        // RUN's own device; a device-less run (`run.deviceId === null`)
        // can never satisfy this, matching `checkAgentGuardrails`'s own
        // device-less-mutation deny at release time.
        suggestionReason = 'target_mismatch';
        console.warn('[alertVerdicts] suggestion refused — target alert is not on the run\'s device', {
          runId: run.id, alertId: suggestion.alertId, targetDeviceId, runDeviceId: run.deviceId,
        });
      } else {
        canAttemptIntent = true;
      }
    }
  }

  const targetWhere = run.correlationGroupId
    ? eq(aiAlertVerdicts.correlationGroupId, run.correlationGroupId)
    : eq(aiAlertVerdicts.alertId, run.alertId!);

  // See the file header's "Write ordering, part 2" note: supersede the
  // existing live row(s) FIRST (pointing at a client-generated id that does
  // not exist yet — safe only because the self-FK is DEFERRABLE INITIALLY
  // DEFERRED), then INSERT the new row with that id. Both statements run in
  // the ONE transaction `inSystemDbContext` already opens.
  const newId = randomUUID();
  let verdictId: string;
  let supersededConcurrently = false;
  try {
    verdictId = await inSystemDbContext(async () => {
      await db.update(aiAlertVerdicts).set({ supersededBy: newId })
        .where(and(
          eq(aiAlertVerdicts.orgId, run.orgId),
          targetWhere,
          isNull(aiAlertVerdicts.supersededBy),
        ));

      await db.insert(aiAlertVerdicts).values({
        id: newId,
        orgId: run.orgId,
        runId: run.id,
        alertId: run.correlationGroupId ? null : run.alertId,
        correlationGroupId: run.correlationGroupId,
        classification: verdict.classification,
        confidence: verdict.confidence.toFixed(2),
        rationale: verdict.rationale,
        pattern: verdict.pattern ?? null,
        suggestedIntentId: null,
      });

      return newId;
    });
  } catch (error) {
    if (!isPgUniqueViolation(error, liveVerdictUniqueConstraintName(run.correlationGroupId))) throw error;
    supersededConcurrently = true;
    console.warn('[alertVerdicts] verdict superseded concurrently — another run\'s write won the race', {
      runId: run.id, alertId: run.alertId, correlationGroupId: run.correlationGroupId,
    });
    // The 23505 itself proves a live row exists for this target right now.
    // Re-reading it (rather than assuming `newId`, which never landed) gives
    // the caller a real, dereferenceable verdict id — the winning run's, not
    // this one's.
    const winner = await inSystemDbContext(async () => {
      const [row] = await db.select({ id: aiAlertVerdicts.id }).from(aiAlertVerdicts)
        .where(and(eq(aiAlertVerdicts.orgId, run.orgId), targetWhere, isNull(aiAlertVerdicts.supersededBy)))
        .limit(1);
      return row;
    });
    // MINOR 3 (fix round 1): do NOT fabricate an id. `newId` never landed —
    // that INSERT is exactly what just 23505'd — so falling back to it would
    // hand the caller a verdictId that dereferences nothing. With the
    // partial unique index in place, a 23505 on this constraint MUST mean a
    // live row exists for this target; a missing `winner` here means that
    // invariant broke (e.g. it was superseded again between the failed
    // INSERT and this SELECT, which nothing in this codepath does), and an
    // honest throw is far better than a silently wrong id.
    if (!winner) {
      throw new Error('ai_alert_verdicts: unique violation but no live row found');
    }
    verdictId = winner.id;
  }

  if (supersededConcurrently) {
    return {
      verdictId,
      intentId: null,
      suggestionDisposition: 'not_created',
      suggestionReason: 'superseded_concurrently',
    };
  }

  let intentId: string | null = null;
  if (canAttemptIntent && suggestion) {
    try {
      const intent = await createActionIntent(agentAuth, {
        toolName: 'manage_alerts',
        input: suggestion.action === 'suppress'
          ? {
            action: 'suppress', alertId: suggestion.alertId, deviceId: targetDeviceId ?? undefined,
            suppressDuration: suggestion.suppressDuration, resolutionNote: verdict.rationale,
          }
          : { action: 'resolve', alertId: suggestion.alertId, deviceId: targetDeviceId ?? undefined, resolutionNote: verdict.rationale },
        source: 'ai_agent',
        orgId: run.orgId,
        reason: verdict.rationale,
        idempotencyKey: `verdict:${run.id}`,
      });
      // CRITICAL fix (review round 1): createActionIntent does NOT throw
      // when nobody can approve — it commits the intent and immediately
      // cancels it with `no_eligible_approvers`, returning that
      // snapshot (mirrors runLoop.ts's `recordProposal`). Linking/
      // pushing anything but a genuinely PENDING intent would advertise
      // a dead intent id and break the "`intent_ids` are pending-only"
      // invariant `routes/aiAgents.ts` depends on.
      if (intent.status === 'pending_approval') {
        intentId = intent.id;
        suggestionDisposition = 'intent_created';
      } else {
        suggestionReason = intent.errorCode === 'no_eligible_approvers' ? 'no_eligible_approvers' : 'intent_error';
        console.warn('[alertVerdicts] suggestion intent was not left pending approval', {
          runId: run.id, alertId: suggestion.alertId, intentId: intent.id,
          status: intent.status, errorCode: intent.errorCode,
        });
      }
    } catch (error) {
      // agent_policy_denied, org_resolution_failed, … The VERDICT is
      // already recorded above — losing the classification because the
      // suggested mutation couldn't be submitted would throw away the
      // useful half of the run's output.
      suggestionReason = 'intent_error';
      console.warn('[alertVerdicts] suggestion intent not created', {
        runId: run.id, alertId: suggestion.alertId, error: (error as Error).message,
      });
    }

    if (intentId) {
      await inSystemDbContext(() => db.update(aiAlertVerdicts)
        .set({ suggestedIntentId: intentId })
        .where(eq(aiAlertVerdicts.id, verdictId)));
    }
  }

  return { verdictId, intentId, suggestionDisposition, suggestionReason };
}

/**
 * Phase 2 wave P2-1 (alert verdicts), Task 14 — the safe projection of one
 * LIVE `ai_alert_verdicts` row for the alerts API (`GET /alerts`, `GET
 * /alerts/:id`, and a correlation group's `GET /correlations/:groupId`).
 * See `AlertAiVerdictSummaryDto`'s own docstring (@breeze/shared) for why
 * this is a DIFFERENT (smaller) projection than `AiAgentRunAlertVerdictDto`:
 * this call site only ever has the persisted row, never the run.
 */
export function projectAlertAiVerdictSummary(row: AiAlertVerdictRow): AlertAiVerdictSummaryDto {
  return {
    id: row.id,
    classification: row.classification,
    confidence: Number(row.confidence),
    rationale: row.rationale,
    patternKind: row.pattern?.kind ?? null,
    feedback: row.feedback,
    suggestedIntentId: row.suggestedIntentId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `orgId` accepts a single org (the common case — an org-scoped or a
 * single-org partner-scoped caller) or an array (Task 14 — a partner/system
 * caller's `GET /alerts` list can legitimately span multiple orgs in one
 * page). An `inArray` widening was chosen over the alternative of the
 * caller grouping alert ids by org and issuing one call per org: the alerts
 * this function is ever asked about already came from a single prior
 * `alerts` query the caller ran under its own tenancy scoping (RLS plus, for
 * partner scope, an explicit `accessibleOrgIds` filter) — this is a second,
 * narrower read of the SAME already-authorized id set, not a new access
 * decision, so one widened query is both the smaller change and the cheaper
 * one (a single round trip instead of up to N).
 *
 * I3 fix (P2-1 wave B task 16d): `persistAlertVerdict` writes a group
 * verdict with `alert_id IS NULL` / `correlation_group_id` set — a
 * `duplicate_of_group` classification on the GROUP was otherwise invisible
 * to every member alert (neither this map nor `hideAiNoiseCondition` ever
 * matched it). Ruling: a group verdict applies to every member alert. Two
 * queries, not N:
 *   1. ALERT-level live verdicts for the requested ids — these WIN when an
 *      alert has both an alert-level and (via its group) a group-level
 *      verdict.
 *   2. For the ids still unmapped after (1), the latest live GROUP-level
 *      verdict of any correlation group the alert is a member of
 *      (`alert_correlation_members`, org-scoped on the join row — same
 *      tenancy axis `alert_correlation_members` already carries).
 */
export async function latestVerdictsForAlerts(
  orgId: string | string[],
  alertIds: string[],
): Promise<Map<string, AiAlertVerdictRow>> {
  if (alertIds.length === 0) return new Map();
  const orgCondition = Array.isArray(orgId) ? inArray(aiAlertVerdicts.orgId, orgId) : eq(aiAlertVerdicts.orgId, orgId);
  const rows = await db.select().from(aiAlertVerdicts)
    .where(and(
      orgCondition,
      inArray(aiAlertVerdicts.alertId, alertIds),
      isNull(aiAlertVerdicts.supersededBy),
    ))
    .orderBy(desc(aiAlertVerdicts.createdAt));
  // `supersededBy IS NULL` should already guarantee at most one live row per
  // target; the ordering + `!map.has` guard is defensive belt-and-suspenders
  // for a same-millisecond race rather than something expected to matter.
  const map = new Map<string, AiAlertVerdictRow>();
  for (const row of rows) {
    if (row.alertId && !map.has(row.alertId)) map.set(row.alertId, row);
  }

  const remaining = alertIds.filter((id) => !map.has(id));
  if (remaining.length > 0) {
    const memberOrgCondition = Array.isArray(orgId)
      ? inArray(alertCorrelationMembers.orgId, orgId)
      : eq(alertCorrelationMembers.orgId, orgId);
    const groupRows = await db.select({
      alertId: alertCorrelationMembers.alertId,
      verdict: aiAlertVerdicts,
    })
      .from(alertCorrelationMembers)
      .innerJoin(aiAlertVerdicts, eq(aiAlertVerdicts.correlationGroupId, alertCorrelationMembers.groupId))
      .where(and(
        memberOrgCondition,
        // Task 16e fix: the alert-level query above pins `orgCondition` on
        // `aiAlertVerdicts` directly — this join only pinned it on the
        // `alertCorrelationMembers` side. Both rows share the same tenancy
        // axis today, but the joined `aiAlertVerdicts` row had no org
        // predicate of its own, so this defense-in-depth matches the
        // alert-level query above rather than trusting the join alone.
        orgCondition,
        inArray(alertCorrelationMembers.alertId, remaining),
        isNull(aiAlertVerdicts.supersededBy),
      ))
      .orderBy(desc(aiAlertVerdicts.createdAt));
    for (const row of groupRows) {
      if (!map.has(row.alertId)) map.set(row.alertId, row.verdict);
    }
  }

  return map;
}

export async function latestVerdictForGroup(orgId: string, groupId: string): Promise<AiAlertVerdictRow | null> {
  const [row] = await db.select().from(aiAlertVerdicts)
    .where(and(
      eq(aiAlertVerdicts.orgId, orgId),
      eq(aiAlertVerdicts.correlationGroupId, groupId),
      isNull(aiAlertVerdicts.supersededBy),
    ))
    .orderBy(desc(aiAlertVerdicts.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * `recordVerdictFeedback`'s outcome — `'ok'` when the caller's feedback was
 * (re)written, `'not_found'` when the id doesn't exist or isn't RLS-visible,
 * `'conflict'` (carry-in B, PR-A review) when the row already carries
 * ANOTHER user's feedback. `orgId` rides along on `'ok'`/`'conflict'` so the
 * route can write the audit line (`writeRouteAudit` requires one) without a
 * second query.
 */
export type RecordVerdictFeedbackResult =
  | { status: 'ok'; orgId: string }
  | { status: 'not_found' }
  | { status: 'conflict'; orgId: string };

/**
 * Feedback is not a mutation of customer data (it never touches `alerts` or
 * anything an org admin would consider "their" data) — the route gates this
 * on the read permission, not write. The request already runs inside
 * `withDbAccessContext`, so RLS is the actual boundary here; filtering by
 * `id` alone (no app-layer org predicate) is intentional, matching the
 * `GET /runs/:runId` route's own "RLS is the boundary, the app predicate is
 * defence-in-depth" precedent.
 *
 * Carry-in B (PR-A review) — a caller must not silently overwrite ANOTHER
 * user's already-recorded feedback (the SAME user changing their own mind is
 * fine). The UPDATE itself carries that check as a `WHERE feedback_by IS
 * NULL OR feedback_by = <this user>` CAS, so the write is race-safe: two
 * different users racing to be first can never both "win" a lost update.
 * When the CAS matches zero rows, a follow-up SELECT (not itself atomic with
 * the UPDATE, but the stakes here are display-only feedback, not customer
 * data — see the paragraph above) distinguishes "id doesn't exist" from
 * "exists, but someone else already recorded feedback" for the 404-vs-409
 * the route answers.
 */
export async function recordVerdictFeedback(
  auth: AuthContext,
  verdictId: string,
  feedback: 'up' | 'down',
): Promise<RecordVerdictFeedbackResult> {
  const [updated] = await db.update(aiAlertVerdicts)
    .set({ feedback, feedbackBy: auth.user.id, feedbackAt: new Date() })
    .where(and(
      eq(aiAlertVerdicts.id, verdictId),
      or(isNull(aiAlertVerdicts.feedbackBy), eq(aiAlertVerdicts.feedbackBy, auth.user.id)),
    ))
    .returning({ id: aiAlertVerdicts.id, orgId: aiAlertVerdicts.orgId });

  if (updated) return { status: 'ok', orgId: updated.orgId };

  const [existing] = await db.select({ orgId: aiAlertVerdicts.orgId })
    .from(aiAlertVerdicts)
    .where(eq(aiAlertVerdicts.id, verdictId))
    .limit(1);
  if (!existing) return { status: 'not_found' };
  return { status: 'conflict', orgId: existing.orgId };
}
