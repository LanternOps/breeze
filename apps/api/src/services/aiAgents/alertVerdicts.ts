// apps/api/src/services/aiAgents/alertVerdicts.ts
/**
 * Phase 2 wave P2-1 (alert verdicts) — Task 8. Persists the `AlertVerdictOutcome`
 * a `verdict`-profile run produced (`runLoop.ts`'s `finishRun`), converts an
 * optional `suggestedAction` into a Tier-2 `supervised` `manage_alerts`
 * action-intent for the `ai_agent` principal (Task 3's `createActionIntent`
 * contract), and provides the safe `AiAgentRunAlertVerdictDto` projection
 * `runTrace.ts` puts on the wire.
 *
 * `persistAlertVerdict` is called from the background run loop (no ambient
 * request context), so its own reads/writes run inside a local system db
 * context — same duplicated-per-file `inSystemDbContext` pattern as every
 * other file in this directory (agentCircuit.ts, fixWatch.ts, runService.ts,
 * …). `createActionIntent` is called OUTSIDE that wrapper, deliberately —
 * it manages its own `withSystemDbAccessContext` internally (see
 * intentService.ts), and nesting would take a SECOND pooled connection
 * while the first is still held (the exact hazard `inSystemDbContext`'s own
 * docstring warns about). This mirrors runLoop.ts's `recordProposal`, which
 * calls `createActionIntent` bare for the same reason.
 *
 * `latestVerdictsForAlerts` / `latestVerdictForGroup` / `recordVerdictFeedback`
 * are request-path helpers (explicit `orgId`/RLS-scoped `id` lookups) and are
 * NOT wrapped in a system context — they run inside the caller's own
 * `withDbAccessContext`, same as every other read in `routes/aiAgents.ts`.
 */

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { AlertVerdictOutcome, AiAgentRunAlertVerdictDto } from '@breeze/shared';
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
 * Safe projection of one `ai_alert_verdicts` row (or the in-flight
 * `AlertVerdictOutcome`, same shape) for `GET /ai/agents/runs/:runId`'s
 * detail DTO. No raw tool args, no `deviceId`/`suppressDuration` off
 * `suggestedAction` — display fields only, matching
 * `AiAgentRunAlertVerdictDto`'s leak-impossible-by-construction contract
 * (@breeze/shared's aiAgentRuns.ts).
 */
export function projectAlertVerdict(v: AlertVerdictOutcome | undefined): AiAgentRunAlertVerdictDto | null {
  if (!v) return null;
  return {
    classification: v.classification,
    confidence: v.confidence,
    rationale: v.rationale,
    patternKind: v.pattern?.kind ?? null,
    evidenceAlertIds: v.pattern?.evidenceAlertIds ?? [],
    suggestedAction: v.suggestedAction ? { tool: 'manage_alerts', action: v.suggestedAction.action } : null,
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

export async function persistAlertVerdict(
  run: {
    id: string; orgId: string; agentId: string; alertId: string | null;
    correlationGroupId: string | null; deviceId: string | null;
  },
  verdict: AlertVerdictOutcome,
  agentAuth: AuthContext,
): Promise<{ verdictId: string; intentId: string | null }> {
  let intentId: string | null = null;
  const suggestion = verdict.suggestedAction;
  if (suggestion) {
    // Confidence floor mirrors the guardrail spirit elsewhere in this wave:
    // a low-confidence classification may still be worth recording, but its
    // suggested mutation is not worth putting in front of a human approver.
    const eligible = verdict.confidence >= 0.8 && await suggestionTargetsRun(run, suggestion.alertId);
    if (eligible) {
      try {
        const [target] = await inSystemDbContext(() => db
          .select({ deviceId: alerts.deviceId })
          .from(alerts)
          .where(and(eq(alerts.id, suggestion.alertId), eq(alerts.orgId, run.orgId)))
          .limit(1));
        const intent = await createActionIntent(agentAuth, {
          toolName: 'manage_alerts',
          input: suggestion.action === 'suppress'
            ? {
              action: 'suppress', alertId: suggestion.alertId, deviceId: target?.deviceId,
              suppressDuration: suggestion.suppressDuration, resolutionNote: verdict.rationale,
            }
            : { action: 'resolve', alertId: suggestion.alertId, deviceId: target?.deviceId, resolutionNote: verdict.rationale },
          source: 'ai_agent',
          orgId: run.orgId,
          reason: verdict.rationale,
          idempotencyKey: `verdict:${run.id}`,
        });
        intentId = intent.id;
      } catch (error) {
        // no_eligible_approvers, agent_policy_denied, … The VERDICT is still
        // recorded below — losing the classification because the suggested
        // mutation couldn't be submitted would throw away the useful half
        // of the run's output.
        console.warn('[alertVerdicts] suggestion intent not created', {
          runId: run.id, alertId: suggestion.alertId, error: (error as Error).message,
        });
      }
    } else {
      console.warn('[alertVerdicts] suggestion refused — target mismatch or confidence below threshold', {
        runId: run.id, alertId: suggestion.alertId, confidence: verdict.confidence,
      });
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

  return { verdictId, intentId };
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
    ));
  const map = new Map<string, AiAlertVerdictRow>();
  for (const row of rows) {
    if (row.alertId) map.set(row.alertId, row);
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
