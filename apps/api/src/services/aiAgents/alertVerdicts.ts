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
 */

import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type {
  AlertVerdictOutcome, AlertVerdictSuggestionDisposition, AlertVerdictSuggestionReason,
  AiAgentRunAlertVerdictDto,
} from '@breeze/shared';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { aiAlertVerdicts, alertCorrelationMembers, alerts, type AiAlertVerdictRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createActionIntent } from '../actionIntents/intentService';

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

export async function persistAlertVerdict(
  run: {
    id: string; orgId: string; alertId: string | null;
    correlationGroupId: string | null; deviceId: string | null;
  },
  verdict: AlertVerdictOutcome,
  agentAuth: AuthContext,
): Promise<PersistAlertVerdictResult> {
  let intentId: string | null = null;
  let suggestionDisposition: AlertVerdictSuggestionDisposition = 'not_created';
  let suggestionReason: AlertVerdictSuggestionReason | undefined;
  const suggestion = verdict.suggestedAction;

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
      let targetDeviceId: string | null | undefined;
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
      } else {
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
          // still recorded below — losing the classification because the
          // suggested mutation couldn't be submitted would throw away the
          // useful half of the run's output.
          suggestionReason = 'intent_error';
          console.warn('[alertVerdicts] suggestion intent not created', {
            runId: run.id, alertId: suggestion.alertId, error: (error as Error).message,
          });
        }
      }
    }
  }

  const targetWhere = run.correlationGroupId
    ? eq(aiAlertVerdicts.correlationGroupId, run.correlationGroupId)
    : eq(aiAlertVerdicts.alertId, run.alertId!);

  const verdictId = await inSystemDbContext(async () => {
    const [row] = await db.insert(aiAlertVerdicts).values({
      orgId: run.orgId,
      runId: run.id,
      alertId: run.correlationGroupId ? null : run.alertId,
      correlationGroupId: run.correlationGroupId,
      classification: verdict.classification,
      confidence: verdict.confidence.toFixed(2),
      rationale: verdict.rationale,
      pattern: verdict.pattern ?? null,
      suggestedIntentId: intentId,
    }).returning({ id: aiAlertVerdicts.id });

    // Supersede every earlier LIVE verdict for the same target, excluding
    // the row just written — a single UPDATE, not a ternary-with-undefined
    // WHERE clause.
    await db.update(aiAlertVerdicts).set({ supersededBy: row!.id })
      .where(and(
        eq(aiAlertVerdicts.orgId, run.orgId),
        targetWhere,
        isNull(aiAlertVerdicts.supersededBy),
        ne(aiAlertVerdicts.id, row!.id),
      ));

    return row!.id;
  });

  return { verdictId, intentId, suggestionDisposition, suggestionReason };
}

export async function latestVerdictsForAlerts(
  orgId: string,
  alertIds: string[],
): Promise<Map<string, AiAlertVerdictRow>> {
  if (alertIds.length === 0) return new Map();
  const rows = await db.select().from(aiAlertVerdicts)
    .where(and(
      eq(aiAlertVerdicts.orgId, orgId),
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
 * Feedback is not a mutation of customer data (it never touches `alerts` or
 * anything an org admin would consider "their" data) — the route gates this
 * on the read permission, not write. The request already runs inside
 * `withDbAccessContext`, so RLS is the actual boundary here; filtering by
 * `id` alone (no app-layer org predicate) is intentional, matching the
 * `GET /runs/:runId` route's own "RLS is the boundary, the app predicate is
 * defence-in-depth" precedent.
 */
export async function recordVerdictFeedback(
  auth: AuthContext,
  verdictId: string,
  feedback: 'up' | 'down',
): Promise<boolean> {
  const rows = await db.update(aiAlertVerdicts)
    .set({ feedback, feedbackBy: auth.user.id, feedbackAt: new Date() })
    .where(eq(aiAlertVerdicts.id, verdictId))
    .returning({ id: aiAlertVerdicts.id });
  return rows.length > 0;
}
