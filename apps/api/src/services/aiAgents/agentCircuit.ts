// apps/api/src/services/aiAgents/agentCircuit.ts
/**
 * Wave 6 PR 2 (#3828), Task 2 — the per-org circuit breaker.
 *
 * `classifyTerminal` decides, per terminal run outcome, whether the (org,
 * agent) failure counter increments, resets, or is left alone (`neutral`).
 * `recordRunTerminal` is the ONLY writer of `ai_agent_circuit_state` — called
 * exclusively from `runService.ts`'s `transitionRunStatus`, which is in turn
 * the ONE place a run's status may become terminal (see the terminalization
 * contract test, `runService.terminalization.contract.test.ts`). Nothing in
 * this module ever mutates `ai_agent_runs` — the circuit watches run
 * outcomes, it never produces one (self-review: "admission-only, never
 * terminates in-flight work").
 *
 * `isCircuitOpen` is the admission-time READ (`createAndEnqueueAgentRun`).
 * `resetCircuit` is the ONLY way a circuit closes once open — always a human,
 * always MFA-gated, NEVER automatic (wave-6 quorum, 2026-08-28): a clean
 * success after the circuit has already opened (an in-flight run that was
 * admitted before the open) still zeroes the failure counter via `reset`
 * classification, but deliberately never flips `state` back to `closed` —
 * only `resetCircuit` does that.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { AgentRunVerdict, AiAgentRecipients, AiAgentRunProfile, AiAgentRunStatus } from '@breeze/shared';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, not the schema barrel — same reasoning as
// runService.ts and runFinishedNotify.ts: this sits on the run-terminalization
// and admission paths, and the barrel would drag every partial-mock unit test
// of those paths into stubbing the whole schema surface.
import {
  aiAgentCircuitState,
  type AiAgentCircuitStateRow,
  type AiAgentCircuitStateValue,
} from '../../db/schema/aiAgentCircuitState';
import { aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
import { createNotification } from '../userNotifications';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import { resolveRecipientUserIds } from './recipients';

/**
 * Same skip-if-already-system shape duplicated across this module family
 * (runService.ts, runFinishedNotify.ts, effectivePolicy.ts, aiKillState.ts) —
 * see any of those for why it is a copy, not an import.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * A DEDICATED advisory-lock namespace, distinct from
 * `AGENT_RUN_ADMISSION_LOCK_NAMESPACE` (3824, runService.ts) — the two must
 * never collide, or a rolling deploy could serialise unrelated admission and
 * circuit-accounting work against each other for no reason. Arbitrary but
 * must never change, same rule as the admission namespace.
 */
const AGENT_CIRCUIT_LOCK_NAMESPACE = 3825;

async function takeCircuitLock(orgId: string, agentId: string): Promise<void> {
  // Two-arg (int4, int4) form, mirroring runService.ts's admission lock. The
  // key STRING is prefixed 'ai-circuit:' (not just `${orgId}:${agentId}`) so
  // the hash space is distinguishable from any other feature that hashes the
  // same (org, agent) pair into the shared advisory-lock keyspace, even
  // though the dedicated namespace above already prevents a real collision.
  await db.execute(sql`select pg_advisory_xact_lock(
    ${AGENT_CIRCUIT_LOCK_NAMESPACE}::int4,
    hashtext(${`ai-circuit:${orgId}:${agentId}`})
  )`);
}

/**
 * Runner/execution-ceiling failure codes `ai_agent_runs.error_code` actually
 * carries alongside `status: 'failed'` (grepped from runLoop.ts's
 * `RESULT_DISPOSITIONS`, ceiling computation, `AgentRunError` throw sites, and
 * the loop's catch-all). Deliberately an ALLOWLIST, not "everything except
 * stalled/enqueue_failed": a failure code this list doesn't know about
 * classifies `neutral` rather than silently counting against the org's
 * threshold — a missed increment is far cheaper than a circuit that opens on
 * an infrastructure hiccup nobody enumerated.
 *
 * `stalled` (runService.ts's `reapStalledAgentRuns`) and `enqueue_failed`
 * (runService.ts's `failRunAfterEnqueueFailure`) are deliberately EXCLUDED —
 * both are the platform failing the agent (a SIGKILLed worker, a BullMQ
 * enqueue that never landed), not the agent doing anything wrong, and neither
 * should erode an org's failure budget.
 */
const INCREMENT_FAILURE_ERROR_CODES: ReadonlySet<string> = new Set([
  // RESULT_DISPOSITIONS failure dispositions (SDK result-subtype mapping).
  'sdk_error',
  'sdk_output_error',
  // Execution-ceiling codes (wall clock / budget / turn count exceeded with
  // nothing useful produced).
  'wall_clock_exceeded',
  'budget_exceeded',
  'max_turns_exceeded',
  // AgentRunError thrown inside driveSdkLoop.
  'llm_unavailable',
  // The loop's catch-all fallback codes for an uncaught throw.
  'ownership_mismatch',
  'run_failed',
]);

export type TerminalClassification = 'increment' | 'reset' | 'neutral';

/**
 * Profiles whose SUCCESS carries no information about the org's remediation
 * health, so a terminal `completed`/`awaiting_approval` neither resets nor
 * increments the streak — see `classifyTerminal`'s docstring for the
 * per-profile reasoning. `failed` is deliberately NOT governed by this set:
 * every profile can genuinely error out, and the runner/ceiling allowlist is
 * the only thing that decides `increment` vs `neutral` there.
 *
 * Typed `ReadonlySet<AiAgentRunProfile>` so a misspelled member is a compile
 * error. Membership is still a DECISION, not a derivation — see the "fifth
 * profile" note on `classifyTerminal`.
 */
const STREAK_NEUTRAL_PROFILES: ReadonlySet<AiAgentRunProfile> = new Set([
  'verdict', 'sweep', 'narrative', 'triage',
]);

/**
 * Pure, exhaustive-tested classification of one terminal run transition.
 *
 * - `increment`: `failed` with a runner/ceiling error code, OR `completed`
 *   with `runVerdict === 'needs_attention'` (the agent finished but flagged
 *   something a human needs to look at — treated the same as a failure for
 *   circuit-breaker purposes, per the wave-6 quorum).
 * - `reset`: a clean `completed` (no `needs_attention`), or `awaiting_approval`
 *   (the agent did real, unflagged work and handed a decision to a human).
 * - `neutral`: `cancelled`, `expired`, `skipped` — and a `failed` whose error
 *   code is not on the increment allowlist (`stalled`, `enqueue_failed`, or
 *   anything unrecognized). Also the safe default for a non-terminal status
 *   (`queued`/`running`), which callers must never actually pass here.
 *
 * `profile` (phase 2 wave P2-1, default `'full'` so every pre-existing
 * 3-arg call site keeps its old behavior unchanged): a `verdict`-profile run
 * never touches the org's failure streak either way — `completed` and
 * `awaiting_approval` both classify `neutral` regardless of `runVerdict`
 * (a verdict run never actually reaches `awaiting_approval`, but the
 * classification stays honest rather than assuming that). `failed` is
 * unaffected by profile — the runner/ceiling increment allowlist still
 * applies, since a verdict run can genuinely error out the same way a full
 * run can.
 *
 * Phase 2 wave P2-2 (scheduled sweeps, design-review ruling): a
 * `sweep`-profile run gets the SAME `completed`/`awaiting_approval` →
 * `neutral` treatment as `verdict`, for a different reason — a sweep run's
 * success says nothing about the org's remediation health (it is read-only
 * reconnaissance, never a remediation attempt), so it never RESETS the
 * streak, clean or `needs_attention` alike; a genuine failure still
 * increments, exactly as for every other profile.
 *
 * Phase 2 wave P2-3 (weekly org narrative): a `narrative`-profile run is
 * classified identically, and it is the strongest case of the same argument
 * — a narrative run does not even READ live data (its whole input is the
 * pre-collected weekly context) and its tool floor holds nothing but the
 * outcome tool, so its outcome carries no information whatsoever about
 * whether the org's remediation is working. It must therefore never reset a
 * streak the fleet's real remediation runs earned, nor increment one on a
 * `needs_attention` verdict about last week's prose. `failed` stays
 * profile-independent: a narrative run can hit `llm_unavailable` or blow the
 * turn/budget ceiling exactly like any other, and that is a real signal.
 *
 * Phase 2 wave P2-4 (ticket triage, #4191): a `triage`-profile run gets the
 * SAME `completed`/`awaiting_approval` -> `neutral` treatment, for the
 * same-shaped reason as `narrative` — it does not read any live data (its
 * whole input is the system-assembled ticket context) and its output is a
 * PROPOSAL a human must still accept before anything changes, so a clean
 * completion carries no information about the org's remediation health
 * either. `failed` stays profile-independent here too.
 *
 * NOTE for whoever adds the sixth profile: this function compares `profile`
 * as a plain string and has NO exhaustive `never` guard (unlike
 * `profileCaps` in `runService.ts` or `outcomeToolsForProfile` in
 * `outcomeTools.ts`). Adding a value to `AI_AGENT_RUN_PROFILES` will NOT
 * fail to compile here — it will silently inherit `full`'s reset/increment
 * behaviour. `agentCircuit.test.ts` carries an explicit row per profile for
 * exactly that reason.
 */
export function classifyTerminal(
  to: AiAgentRunStatus,
  errorCode: string | null,
  runVerdict: AgentRunVerdict | null,
  profile: AiAgentRunProfile = 'full',
): TerminalClassification {
  if (to === 'completed') {
    if (STREAK_NEUTRAL_PROFILES.has(profile)) return 'neutral';
    return runVerdict === 'needs_attention' ? 'increment' : 'reset';
  }
  if (to === 'awaiting_approval') return STREAK_NEUTRAL_PROFILES.has(profile) ? 'neutral' : 'reset';
  if (to === 'failed') {
    return errorCode !== null && INCREMENT_FAILURE_ERROR_CODES.has(errorCode) ? 'increment' : 'neutral';
  }
  return 'neutral';
}

/** Every status the `AiAgentRunStatus` union carries EXCEPT the two non-terminal ones. */
export function isTerminalRunStatus(status: AiAgentRunStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

export interface TerminalRunContext {
  id: string;
  orgId: string;
  agentId: string;
  /** Phase 2 wave P2-1 — threaded into `classifyTerminal` so a verdict run's
   *  clean completion never resets (or increments) the circuit's streak. */
  profile: AiAgentRunProfile;
}

/**
 * Wire/read shape for both the `GET /:id/circuit` DTO and every internal
 * caller. `state`/`consecutiveFailures` default to the closed/zero row a
 * never-tripped (org, agent) pair has no physical row for — see
 * `getCircuitState`.
 */
export interface AgentCircuitSnapshot {
  orgId: string;
  agentId: string;
  state: AiAgentCircuitStateValue;
  consecutiveFailures: number;
  openedAt: string | null;
  openedReason: string | null;
  lastRunId: string | null;
  lastTransitionAt: string | null;
  resetBy: string | null;
  resetAt: string | null;
}

function defaultSnapshot(orgId: string, agentId: string): AgentCircuitSnapshot {
  return {
    orgId,
    agentId,
    state: 'closed',
    consecutiveFailures: 0,
    openedAt: null,
    openedReason: null,
    lastRunId: null,
    lastTransitionAt: null,
    resetBy: null,
    resetAt: null,
  };
}

function toSnapshot(row: AiAgentCircuitStateRow): AgentCircuitSnapshot {
  return {
    orgId: row.orgId,
    agentId: row.agentId,
    state: row.state,
    consecutiveFailures: row.consecutiveFailures,
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    openedReason: row.openedReason,
    lastRunId: row.lastRunId,
    lastTransitionAt: row.lastTransitionAt ? row.lastTransitionAt.toISOString() : null,
    resetBy: row.resetBy,
    resetAt: row.resetAt ? row.resetAt.toISOString() : null,
  };
}

/**
 * Admission-time read (`createAndEnqueueAgentRun`, right after the kill
 * switch and effective-policy resolution — the earliest point `agentId` is
 * known). System-scoped because a trigger-driven admission (an alert firing)
 * has no per-request RLS context to inherit, same reasoning as
 * `resolveEffectiveAgentSystem`.
 */
export async function isCircuitOpen(orgId: string, agentId: string): Promise<boolean> {
  return inSystemDbContext(async () => {
    const [row] = await db
      .select({ state: aiAgentCircuitState.state })
      .from(aiAgentCircuitState)
      .where(and(eq(aiAgentCircuitState.orgId, orgId), eq(aiAgentCircuitState.agentId, agentId)))
      .limit(1);
    return row?.state === 'open';
  });
}

/**
 * Read for the authenticated `GET /:id/circuit` route (already authorized via
 * `resolveOrgId`/`canAccessOrg` at the route layer) — but also safe to call
 * from a background/system caller with no ambient RLS context at all (an
 * admin CLI, a future scheduled report). Forces a system context rather than
 * trusting the ambient one, same as `isCircuitOpen`: unlike a dual-axis
 * partner-wide table, `ai_agent_circuit_state`'s RLS is a plain
 * `breeze_has_org_access(org_id)` policy — semantically the SAME check the
 * route already performed at the app layer — so there is no "RLS is
 * stricter, never claim parity" gap being papered over here. The failure mode
 * of NOT doing this is worse than the failure mode of doing it: a caller with
 * no ambient context (deny-by-default, per `breeze_current_scope() = 'none'`)
 * would silently read back the closed/zero default for a circuit that is
 * actually OPEN — the one lie this status read must never tell. A
 * never-tripped (org, agent) pair has no row at all; that reads as the
 * closed/zero default rather than a 404.
 */
export async function getCircuitState(orgId: string, agentId: string): Promise<AgentCircuitSnapshot> {
  return inSystemDbContext(async () => {
    const [row] = await db
      .select()
      .from(aiAgentCircuitState)
      .where(and(eq(aiAgentCircuitState.orgId, orgId), eq(aiAgentCircuitState.agentId, agentId)))
      .limit(1);
    return row ? toSnapshot(row) : defaultSnapshot(orgId, agentId);
  });
}

/**
 * The ONLY way an open circuit closes (wave-6 quorum: "manual MFA reset
 * only"). Called from the MFA-gated `POST /:id/circuit/reset` route — same
 * system-context reasoning as `getCircuitState` (the route has already
 * authorized `orgId`/`agentId` at the app layer against the identical
 * `breeze_has_org_access` check this table's RLS enforces). A never-tripped
 * pair has nothing to reset; the UPDATE affects zero rows and this returns
 * the same closed/zero default `getCircuitState` would.
 */
export async function resetCircuit(
  orgId: string,
  agentId: string,
  resetBy: string,
): Promise<AgentCircuitSnapshot> {
  return inSystemDbContext(async () => {
    await takeCircuitLock(orgId, agentId);
    const [row] = await db
      .update(aiAgentCircuitState)
      .set({
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        openedReason: null,
        resetBy,
        resetAt: new Date(),
        lastTransitionAt: new Date(),
      })
      .where(and(eq(aiAgentCircuitState.orgId, orgId), eq(aiAgentCircuitState.agentId, agentId)))
      .returning();
    return row ? toSnapshot(row) : defaultSnapshot(orgId, agentId);
  });
}

interface JustOpened {
  agentRow: { orgId: string | null; partnerId: string | null; recipients: Partial<AiAgentRecipients> };
  agentName: string;
  consecutiveFailures: number;
  threshold: number;
}

/**
 * The ONLY writer of `ai_agent_circuit_state` from the run-terminalization
 * path. Called exclusively from `runService.ts`'s `transitionRunStatus`,
 * AFTER that function's own run-status UPDATE has already committed (its own
 * `inSystemDbContext` call has returned) — deliberately never nested inside
 * that same transaction. A raw INSERT/UPDATE statement failing here (e.g. a
 * transient FK issue) would otherwise poison the run-status transaction at
 * COMMIT time regardless of a try/catch around this call — the exact trap
 * `createAndEnqueueAgentRun`'s dedupe-key reclaim comment documents. Running
 * in a separate transaction means a circuit-accounting failure can never take
 * the run's own terminal status down with it — `transitionRunStatus` already
 * wraps this call in its own try/catch as a second line of defence.
 *
 * Best-effort in a second sense too: threshold resolution
 * (`resolveEffectiveAgentSystem`) and the notify/audit fan-out on a
 * newly-opened circuit run OUTSIDE the row-locked upsert transaction, exactly
 * like `createAndEnqueueAgentRun`'s own "announce, then enqueue — outside the
 * DB context" step 10 — holding a pooled Postgres connection across a Redis
 * round-trip (the notification's live nudge) is the exact anti-pattern that
 * exhausted the pool on 2026-05-21.
 */
export async function recordRunTerminal(
  run: TerminalRunContext,
  to: AiAgentRunStatus,
  errorCode: string | null,
  runVerdict: AgentRunVerdict | null,
): Promise<void> {
  const classification = classifyTerminal(to, errorCode, runVerdict, run.profile);
  if (classification === 'neutral') return;

  const justOpened = await inSystemDbContext(async (): Promise<JustOpened | null> => {
    await takeCircuitLock(run.orgId, run.agentId);

    if (classification === 'reset') {
      // Zeroes the counter unconditionally — including while the circuit is
      // already open, per this module's header: a clean in-flight run never
      // re-closes an open circuit, it only stops the counter it left behind
      // from looking like an ongoing streak.
      await db
        .update(aiAgentCircuitState)
        .set({ consecutiveFailures: 0, lastRunId: run.id, lastTransitionAt: new Date() })
        .where(and(eq(aiAgentCircuitState.orgId, run.orgId), eq(aiAgentCircuitState.agentId, run.agentId)));
      return null;
    }

    // increment path.
    const [agentRow] = await db
      .select({
        kind: aiAgents.kind,
        name: aiAgents.name,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        recipients: aiAgents.recipients,
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    // The agent was deleted between the run and this transition — nothing to
    // account against. `ai_agent_runs.agent_id` is `ON DELETE RESTRICT`
    // (schema/aiAgents.ts), so this is defensive rather than reachable, but a
    // missing row must never throw out of a best-effort accounting path.
    if (!agentRow) return null;

    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, run.orgId))
      .limit(1);
    if (!org) return null;

    const [upserted] = await db
      .insert(aiAgentCircuitState)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        partnerId: org.partnerId,
        consecutiveFailures: 1,
        state: 'closed',
        lastRunId: run.id,
        lastTransitionAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [aiAgentCircuitState.orgId, aiAgentCircuitState.agentId],
        set: {
          consecutiveFailures: sql`${aiAgentCircuitState.consecutiveFailures} + 1`,
          lastRunId: run.id,
          lastTransitionAt: new Date(),
        },
      })
      .returning();
    if (!upserted || upserted.state !== 'closed') return null;

    // Resolved AT THIS MOMENT, never off the run's own (possibly stale)
    // policy snapshot — see AiAgentPolicySnapshot v4's docstring
    // (packages/shared/src/types/aiAgents.ts). Already inside a system
    // context, so this short-circuits to a direct read, no second connection.
    const resolved = await resolveEffectiveAgentSystem(run.orgId, agentRow.kind);
    const threshold = resolved?.effective.limits.maxConsecutiveFailures
      ?? AI_AGENT_LIMIT_DEFAULTS.maxConsecutiveFailures;
    if (upserted.consecutiveFailures < threshold) return null;

    // CAS-style: `WHERE state = 'closed'` guarantees "opens exactly once"
    // even without the advisory lock above — the row lock the upsert just
    // took is held for the rest of this transaction, so no concurrent
    // `recordRunTerminal` call for this (org, agent) can interleave here.
    const [opened] = await db
      .update(aiAgentCircuitState)
      .set({
        state: 'open',
        openedAt: new Date(),
        openedReason:
          `${upserted.consecutiveFailures} consecutive terminal failures (threshold ${threshold})`,
        lastTransitionAt: new Date(),
      })
      .where(and(
        eq(aiAgentCircuitState.orgId, run.orgId),
        eq(aiAgentCircuitState.agentId, run.agentId),
        eq(aiAgentCircuitState.state, 'closed'),
      ))
      .returning();
    if (!opened) return null;

    return {
      agentRow,
      agentName: agentRow.name,
      consecutiveFailures: upserted.consecutiveFailures,
      threshold,
    };
  });

  if (!justOpened) return;

  // Best-effort notify + audit, deliberately OUTSIDE the transaction above.
  try {
    const userIds = await resolveRecipientUserIds(
      {
        orgId: justOpened.agentRow.orgId,
        partnerId: justOpened.agentRow.partnerId,
        recipients: justOpened.agentRow.recipients,
      },
      run.orgId,
    );
    if (userIds.length > 0) {
      await inSystemDbContext(async () => {
        for (const userId of userIds) {
          await createNotification({
            userId,
            orgId: run.orgId,
            type: 'ai',
            title: `Agent circuit breaker opened: ${justOpened.agentName}`,
            message:
              `${justOpened.agentName} hit ${justOpened.consecutiveFailures} consecutive failed/needs-attention `
              + `runs (threshold ${justOpened.threshold}) and has been paused for this organization. `
              + 'A human must reset it before it runs again.',
            link: `/ai-agents/${run.agentId}`,
            priority: 'high',
            metadata: {
              agentId: run.agentId,
              orgId: run.orgId,
              consecutiveFailures: justOpened.consecutiveFailures,
              threshold: justOpened.threshold,
            },
            // Discriminated by the TRIGGERING RUN, not just (org, agent):
            // `user_notifications_user_dedupe_key_uq` has no TTL and no
            // episode discriminator of its own (rows only clear on explicit
            // user delete — marking read does not free the key), so a
            // permanent-per-pair key would notify on the FIRST open ever and
            // go silent on every reopen after a human resets it with MFA.
            // `run.id` is unique per terminal run, so every open episode gets
            // its own key — see agentCircuit.test.ts's "different dedupeKey"
            // regression case.
            dedupeKey: `circuit-open-${run.orgId}-${run.agentId}-${run.id}`,
          });
        }
      });
    }
  } catch (error) {
    console.error('[agentCircuit] failed to notify recipients of a circuit open (non-fatal)', {
      orgId: run.orgId, agentId: run.agentId, error,
    });
  }

  // #4205 — first-class registered event so webhooks/automations can react to
  // a circuit open, not just the notification + audit row above. Best-effort,
  // same posture as both: never allowed to fail this best-effort accounting
  // path.
  try {
    await publishEvent(
      EVENT_TYPES.AI_AGENT_CIRCUIT_OPENED,
      run.orgId,
      {
        agentId: run.agentId,
        orgId: run.orgId,
        triggeringRunId: run.id,
        consecutiveFailures: justOpened.consecutiveFailures,
        threshold: justOpened.threshold,
      },
      'ai-agent-circuit',
    );
  } catch (error) {
    console.error('[agentCircuit] failed to publish a circuit open event (non-fatal)', {
      orgId: run.orgId, agentId: run.agentId, triggeringRunId: run.id, error,
    });
  }

  createAuditLogAsync({
    orgId: run.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: 'ai_agent.circuit_opened',
    resourceType: 'ai_agent',
    resourceId: run.agentId,
    details: {
      agentId: run.agentId,
      orgId: run.orgId,
      triggeringRunId: run.id,
      consecutiveFailures: justOpened.consecutiveFailures,
      threshold: justOpened.threshold,
    },
    result: 'success',
  }).catch((error: unknown) => {
    console.error('[agentCircuit] failed to audit a circuit open (non-fatal)', {
      orgId: run.orgId, agentId: run.agentId, error,
    });
  });
}
