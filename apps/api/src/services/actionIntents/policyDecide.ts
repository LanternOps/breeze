import { and, eq, gt, count, sql } from 'drizzle-orm';
import type { AiAgentKind, AiAgentPolicySnapshot } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { actionIntents, intentOutbox, type ActionIntent } from '../../db/schema/actionIntents';
import { aiUnattendedExposure } from '../../db/schema/aiUnattendedExposure';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
import { organizations } from '../../db/schema/orgs';
import { devices } from '../../db/schema/devices';
import { policyDecideEnabled } from '../../config/env';
import { checkAgentGuardrails, resolveActionForTool, type AgentGuardrailPolicy } from '../aiGuardrails';
import { readAiKillState } from '../aiKillState';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { resolveRecipientUserIds } from '../aiAgents/recipients';
import { countContractDevices } from '../contractQuantities';
import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';
import { validateAuthorizationKeys, POLICY_DECIDABLE_TIER3_VERSION } from './policyDecidable';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
import { recordActionIntentEvent } from './metrics';
import { runDeferredHumanFanout, RELEASE_LEASE_MS } from './intentService';

/**
 * Wave 5 Part B (#3827) — the policy-decide attempt pipeline: the ONE
 * function that turns an agent-originated, `supervised`, `'unattempted'`
 * intent into either a durably policy-authorized `approved` intent (no human
 * ever sees it) or a `human_required` one (the ordinary fan-out runs, just a
 * turn late). See the plan header's Design authority for the eight
 * independent gates this enforces and the deterministic-vs-transient
 * distinction that makes the whole thing safe to retry at least once.
 *
 * Deliberately imports `runDeferredHumanFanout` (and `RELEASE_LEASE_MS`)
 * FROM `intentService.ts` — a real, one-directional static dependency.
 * `intentService.ts`'s own reference back to `attemptPolicyDecision` (its
 * post-commit trigger) is a lazy `import()`, precisely so this direction can
 * stay static without the pair becoming a circular module graph — see
 * `triggerPolicyDecisionAttempt`'s doc comment there.
 */

/**
 * Same skip-if-already-system shape every other leaf module in this
 * directory duplicates locally (actRevalidation.ts, runFinishedNotify.ts)
 * rather than importing — see their headers for why.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Hash of the run's OWN immutable `policy_snapshot` — reuses the SAME
 * canonicalizer the argument/effect digests use (canonicalize.ts) rather
 * than a second bespoke JSON-hashing implementation. Provenance only: this
 * is what authorized the decision, stamped for audit/forensics, not a
 * revalidation target (the run row is immutable, so recomputing it later
 * can only ever equal itself).
 */
export function computePolicySnapshotDigest(snapshot: AiAgentPolicySnapshot): string {
  return computeArgumentDigest(canonicalizeArguments(snapshot as unknown as Record<string, unknown>));
}

/** The canonical POLICY_DECIDABLE_TIER3 key for a stored intent's action —
 *  derived EXACTLY the way checkGuardrails/checkAgentGuardrails resolve the
 *  sub-operation (aiGuardrails.ts's `resolveActionForTool`), never a second
 *  ad hoc parse of `arguments`. */
function canonicalPolicyKey(actionName: string, args: Record<string, unknown>): string {
  const action = resolveActionForTool(actionName, args);
  return action ? `${actionName}:${action}` : actionName;
}

/** Thrown INSIDE the authorize transaction when the final CAS loses a race
 *  it should never lose (the top-level precondition already checked
 *  `policyDecisionState === 'unattempted'`) — forces the transaction
 *  (including the exposure-row insert) to roll back rather than commit an
 *  orphaned reservation for an intent some concurrent caller already
 *  resolved a different way. Caught immediately outside the transaction and
 *  treated as a silent no-op, never a failure. */
class PolicyDecisionRaceLostError extends Error {}

type CapCheckFailure = 'fleet_cap_exceeded' | 'day_cap_exceeded';

interface LoadedIntentForAttempt {
  intent: ActionIntent;
}

async function loadIntentForAttempt(intentId: string): Promise<LoadedIntentForAttempt | null> {
  return inSystemDbContext(async () => {
    const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1);
    return intent ? { intent } : null;
  });
}

interface LoadedRunAndAgent {
  run: { id: string; agentId: string; orgId: string; deviceId: string | null; policySnapshot: AiAgentPolicySnapshot };
  agent: { id: string; name: string; kind: AiAgentKind };
  partnerId: string;
  deviceSiteId: string | null;
}

async function loadRunAndAgent(runId: string, orgId: string): Promise<LoadedRunAndAgent | null> {
  return inSystemDbContext(async () => {
    const [run] = await db
      .select({
        id: aiAgentRuns.id,
        agentId: aiAgentRuns.agentId,
        orgId: aiAgentRuns.orgId,
        deviceId: aiAgentRuns.deviceId,
        policySnapshot: aiAgentRuns.policySnapshot,
      })
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, runId))
      .limit(1);
    if (!run || run.orgId !== orgId) return null;

    const [agent] = await db
      .select({ id: aiAgents.id, name: aiAgents.name, kind: aiAgents.kind })
      .from(aiAgents)
      .where(eq(aiAgents.id, run.agentId))
      .limit(1);
    if (!agent) return null;

    // The org's OWNING partner (organizations.partner_id is NOT NULL) — needed
    // for the exposure row's composite (org_id, partner_id) FK, independent of
    // whether this particular agent is org- or partner-owned.
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;

    // Re-resolve the device's CURRENT site — never the site the run started
    // under (mirrors agentReleaseAuthority.ts / intentService.ts's own
    // creation-time lookup).
    let deviceSiteId: string | null = null;
    if (run.deviceId) {
      const [device] = await db
        .select({ siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, run.deviceId))
        .limit(1);
      deviceSiteId = device?.siteId ?? null;
    }

    return { run, agent, partnerId: org.partnerId, deviceSiteId };
  });
}

/** `errorCode` values this module can degrade an intent with — logged, not
 *  persisted onto the intent row (a `human_required` intent is not an error
 *  state; `errorCode` stays reserved for genuinely terminal outcomes,
 *  matching intentService.ts's existing convention). */
type DegradeReason =
  | 'policy_decide_disabled'
  | 'policy_intent_expired'
  | 'agent_run_invalid'
  | 'agent_identity_changed'
  | 'agent_mode_not_act'
  | 'not_policy_decidable'
  | 'not_agent_authorized'
  | 'kill_switch_engaged'
  | 'agent_policy_denied'
  | CapCheckFailure;

async function degradeToHumanRequired(intentId: string, reason: DegradeReason, details?: Record<string, unknown>): Promise<void> {
  console.log(`[policyDecide] intent ${intentId} degraded to human_required: ${reason}`, details ?? {});
  try {
    await runDeferredHumanFanout(intentId);
  } catch (err) {
    // The degrade decision itself already stands (or will, via the outbox
    // recovery branch retrying attemptPolicyDecision — which no-ops past the
    // CAS this call already tried to win). A fan-out failure here must not
    // propagate as a "transient, retry the WHOLE attempt" signal: retrying
    // attemptPolicyDecision from scratch would just re-evaluate every gate
    // for an intent whose state may already be `human_required`, which is
    // harmless but wasteful — log and move on.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[policyDecide] runDeferredHumanFanout failed for intent ${intentId}:`, err);
  }
}

interface AuthorizeArgs {
  intent: ActionIntent;
  run: LoadedRunAndAgent['run'];
  agentId: string;
  partnerId: string;
  key: string;
  killEpoch: number;
  maxFleetPercentPerDay: number;
  maxPolicyDecisionsPerDay: number;
}

type AuthorizeResult = { ok: true } | { ok: false; reason: CapCheckFailure };

/**
 * The atomic authorize transaction (plan Global Constraints — one
 * transaction, DB-backed, never count-then-write): per-org advisory xact
 * lock -> fleet-percent check -> day-cap check -> exposure reservation
 * insert -> CAS the intent to `approved` with full provenance -> outbox
 * `intent_approved`. All six writes/reads share ONE `withSystemDbAccessContext`
 * call, which itself opens ONE real Postgres transaction (db/index.ts) — the
 * same pattern createActionIntent's own creation transaction uses.
 *
 * Returns `{ok:false, reason}` when a cap is exhausted (nothing was written —
 * the check runs BEFORE the exposure insert) and throws
 * `PolicyDecisionRaceLostError` when the final CAS unexpectedly loses (which
 * rolls the whole transaction, including the exposure insert, back) —
 * `attemptPolicyDecision` treats that as a silent no-op, not a failure.
 */
async function runAuthorizeTransaction(args: AuthorizeArgs): Promise<AuthorizeResult> {
  const { intent, run, agentId, partnerId, key, killEpoch, maxFleetPercentPerDay, maxPolicyDecisionsPerDay } = args;
  const deviceId = run.deviceId;
  if (!deviceId) {
    // Structurally unreachable: checkAgentGuardrails already denies every
    // mutating call from a device-less run before attemptPolicyDecision ever
    // reaches this function (its live-guardrail-re-run step). A genuine
    // invariant violation, not a cap outcome — surfaced as a thrown error
    // (caught by attemptPolicyDecision's outer catch as transient, logged to
    // Sentry) rather than mislabeled with either CapCheckFailure reason.
    throw new Error(`runAuthorizeTransaction: intent ${intent.id}'s run has no deviceId`);
  }

  return inSystemDbContext(async (): Promise<AuthorizeResult> => {
    // Per-org advisory lock (plan Global Constraints): serializes concurrent
    // policy-decide authorizations for the SAME org so the fleet-percent
    // check below can't overshoot by more than one device per race.
    // Released automatically on commit/rollback of this transaction — no
    // separate unlock call.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-exposure:${intent.orgId}`}, 0))`);

    const windowStart = sql`now() - interval '24 hours'`;

    const exposedDeviceRows = await db
      .select({ deviceId: aiUnattendedExposure.deviceId })
      .from(aiUnattendedExposure)
      .where(and(eq(aiUnattendedExposure.orgId, intent.orgId), gt(aiUnattendedExposure.reservedAt, windowStart)));
    const exposedDevices = new Set(exposedDeviceRows.map((r) => r.deviceId));
    const deviceAlreadyExposed = exposedDevices.has(deviceId);

    const contractDeviceCount = await countContractDevices(intent.orgId, null);
    // floor(), no max(1, ·) — a tiny fleet with a nonzero-but-sub-1-device
    // allowance gets ZERO unattended authorizations. That is the correct,
    // intended reading (locked quorum decision): the operator raises
    // maxFleetPercentPerDay if they want unattended authority on a small
    // fleet, this function never silently grants "at least one."
    const allowance = Math.floor((contractDeviceCount * maxFleetPercentPerDay) / 100);
    const projectedDistinctDevices = exposedDevices.size + (deviceAlreadyExposed ? 0 : 1);
    if (projectedDistinctDevices > allowance) {
      return { ok: false, reason: 'fleet_cap_exceeded' };
    }

    const [dayCountRow] = await db
      .select({ n: count() })
      .from(aiUnattendedExposure)
      .where(
        and(
          eq(aiUnattendedExposure.orgId, intent.orgId),
          eq(aiUnattendedExposure.agentId, agentId),
          eq(aiUnattendedExposure.source, 'policy_intent'),
          gt(aiUnattendedExposure.reservedAt, windowStart),
        ),
      );
    const policyDecisionsToday = Number(dayCountRow?.n ?? 0);
    if (policyDecisionsToday >= maxPolicyDecisionsPerDay) {
      return { ok: false, reason: 'day_cap_exceeded' };
    }

    const [reservation] = await db
      .insert(aiUnattendedExposure)
      .values({
        orgId: intent.orgId,
        partnerId,
        agentId,
        runId: run.id,
        deviceId,
        intentId: intent.id,
        source: 'policy_intent',
      })
      .returning({ id: aiUnattendedExposure.id });
    if (!reservation) throw new Error('ai_unattended_exposure insert returned no row');

    const digest = computePolicySnapshotDigest(run.policySnapshot);
    const [updated] = await db
      .update(actionIntents)
      .set({
        status: 'approved',
        policyDecisionState: 'authorized',
        decidedAt: new Date(),
        decidedByUserId: null,
        decidedAssuranceLevel: null,
        decidedVia: 'policy',
        releaseBy: new Date(Date.now() + RELEASE_LEASE_MS),
        policyAuthorizationKey: key,
        policySnapshotDigest: digest,
        policyClassificationVersion: POLICY_DECIDABLE_TIER3_VERSION,
        policyReservationId: reservation.id,
        policyKillEpoch: killEpoch,
      })
      .where(
        and(
          eq(actionIntents.id, intent.id),
          eq(actionIntents.status, 'pending_approval'),
          eq(actionIntents.policyDecisionState, 'unattempted'),
        ),
      )
      .returning({ id: actionIntents.id });
    if (!updated) {
      // Lost a race the top-level precondition should have prevented — roll
      // back the exposure reservation too (see the class doc comment).
      throw new PolicyDecisionRaceLostError(`intent ${intent.id} CAS lost inside the authorize transaction`);
    }

    await db.insert(intentOutbox).values({
      intentId: intent.id,
      eventType: 'intent_approved',
      payload: { intentId: intent.id, orgId: intent.orgId },
    });

    return { ok: true };
  });
}

/** Best-effort "authorized automatically by policy" notification to the
 *  agent's resolved recipients — mirrors runFinishedNotify.ts's own
 *  recipient-resolution + notify pattern. Never blocks or reverses the
 *  authorization: a notify failure here is logged, not retried, exactly
 *  like every other post-commit notification in this subsystem (#1105 —
 *  outside any held transaction). */
async function notifyRecipientsOfPolicyAuthorization(args: {
  orgId: string;
  partnerId: string | null;
  recipients: AiAgentPolicySnapshot['effective']['recipients'];
  agentName: string;
  intentId: string;
  targetSummary: string;
}): Promise<void> {
  try {
    const userIds = await resolveRecipientUserIds(
      { orgId: args.orgId, partnerId: args.partnerId, recipients: args.recipients },
      args.orgId,
    );
    await inSystemDbContext(async () => {
      for (const userId of userIds) {
        await createNotification({
          userId,
          orgId: args.orgId,
          type: 'ai',
          title: `${args.agentName}: authorized automatically by policy`,
          message: `${args.targetSummary} — executing`,
          link: '/approvals',
          metadata: { intentId: args.intentId, decidedVia: 'policy' },
          dedupeKey: `intent-policy-authorized:${args.intentId}`,
        });
      }
    });
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[policyDecide] recipient notification failed for intent ${args.intentId}:`, err);
  }
}

/**
 * The policy-decide attempt for one intent. Idempotent by construction (the
 * `policyDecisionState` CAS is the single-transition guard both this
 * function's own precondition check and the authorize transaction's final
 * UPDATE rely on) — safe to call more than once for the same intent, from
 * the post-commit fire-and-forget trigger AND the outbox `intent_created`
 * recovery branch, without ever double-authorizing or double-fanning-out.
 *
 * Never throws: every failure this function can encounter is either a
 * DETERMINISTIC refusal (degrades the intent to `human_required` and returns)
 * or a TRANSIENT one (logs and leaves the intent `unattempted` for the
 * outbox's at-least-once redelivery to retry). See the plan header's Design
 * authority for why that distinction is load-bearing.
 */
export async function attemptPolicyDecision(intentId: string): Promise<void> {
  try {
    // Load + confirm this intent is genuinely stranded in `unattempted`
    // BEFORE checking the flag, so intentReleaseWorker.ts's `intent_created`
    // handler can call this function unconditionally (not flag-gated at the
    // call site — see its header comment for why: gating there strands
    // every `unattempted` intent forever if the flag is later flipped off,
    // since this is the only durable caller). An already-decided or
    // human-authored intent's `intent_created` delivery stays a true no-op
    // regardless of the flag.
    const loadedIntent = await loadIntentForAttempt(intentId);
    if (!loadedIntent) return; // gone — nothing to attempt
    const { intent } = loadedIntent;

    if (intent.policyDecisionState !== 'unattempted') return; // already resolved by another caller

    if (!policyDecideEnabled()) {
      // The flag is one of the eight independent gates: an attempt that
      // somehow reaches this function after the flag flipped off mid-flight
      // (a live env read, not a cached snapshot) must degrade, not authorize.
      await degradeToHumanRequired(intentId, 'policy_decide_disabled');
      return;
    }

    if (intent.status !== 'pending_approval') return; // moved on some other way (e.g. manually cancelled)
    if (!intent.requestingAgentRunId) return; // structurally impossible; defensive no-op

    const deadline = intent.approvalExpiresAt ?? intent.expiresAt;
    if (deadline.getTime() <= Date.now()) {
      await degradeToHumanRequired(intentId, 'policy_intent_expired');
      return;
    }

    const loadedRun = await loadRunAndAgent(intent.requestingAgentRunId, intent.orgId);
    if (!loadedRun) {
      await degradeToHumanRequired(intentId, 'agent_run_invalid');
      return;
    }
    const { run, agent, partnerId, deviceSiteId } = loadedRun;

    // Canonical key -> registry membership + headlessCompatible + the
    // defense-in-depth reclassification (policyDecidable.ts's
    // `validateAuthorizationKeys` — re-derives the LIVE approval scope from
    // aiGuardrails' own tables, so a registry-vs-guardrails drift since v1
    // was frozen cannot reopen a since-tightened action to policy decision).
    const key = canonicalPolicyKey(intent.actionName, intent.arguments as Record<string, unknown>);
    const registryCheck = validateAuthorizationKeys([key]);
    if (registryCheck.ok.length === 0) {
      await degradeToHumanRequired(intentId, 'not_policy_decidable', {
        key,
        reason: registryCheck.rejected[0]?.reason,
      });
      return;
    }

    // Current effective policy — the operator's LIVE authorization, not the
    // run's start-of-run snapshot (which may predate the operator ever
    // opting this key in, or postdate them revoking it).
    const current = await resolveEffectiveAgentSystem(intent.orgId, agent.kind);
    if (!current || current.agentId !== run.agentId) {
      await degradeToHumanRequired(intentId, 'agent_identity_changed');
      return;
    }

    // LOCKED quorum decision: policy-decide requires mode === 'act'. This is
    // the primary enforcement point — the live guardrail re-run below is NOT
    // a substitute: checkAgentGuardrails only returns `disposition: 'deny'`
    // for mode 'off' or `enabled: false`; a mutating call under mode
    // 'shadow' returns `disposition: 'propose'`; and nothing gates
    // `supervisedActionKeys` on mode either. Without this check an operator
    // who configures act + keys, then flips the agent to shadow as a brake,
    // would keep having policy-decide silently authorize on the stored keys.
    // Checked against the CURRENT live policy (not the run's start-of-run
    // snapshot) because the policy can change between intent creation and
    // this attempt — kept even after Task 5's `resolvePolicyDecisionState`
    // adds its own creation-time mode check, as defense in depth.
    if (current.effective.mode !== 'act') {
      await degradeToHumanRequired(intentId, 'agent_mode_not_act', { mode: current.effective.mode });
      return;
    }

    const authorizedKeys = current.effective.actAssets.supervisedActionKeys ?? [];
    if (!authorizedKeys.includes(key)) {
      await degradeToHumanRequired(intentId, 'not_agent_authorized', { key });
      return;
    }

    // Kill state, warmed BEFORE the guardrail re-run so its synchronous cache
    // (checkAgentGuardrails reads getCachedAiKillStateSnapshot()) reflects
    // this read, mirroring actRevalidation.ts's / agentReleaseAuthority.ts's
    // own "refresh immediately before the re-run" pattern. Captured for
    // provenance (policy_kill_epoch) regardless of outcome.
    const killState = await readAiKillState();

    const livePolicy: AgentGuardrailPolicy = {
      enabled: current.effective.enabled,
      mode: current.effective.mode,
      toolAllowlist: current.effective.toolAllowlist,
      protectedResources: current.effective.protectedResources,
      deviceId: run.deviceId,
      deviceSiteId,
    };
    const verdict = checkAgentGuardrails(intent.actionName, intent.arguments as Record<string, unknown>, livePolicy);
    if (verdict.disposition === 'deny') {
      // killState.killed is the only thing that can make checkAgentGuardrails
      // deny at its FIRST gate — whenever it's true every other candidate
      // would also deny for the same reason (same distinction
      // agentReleaseAuthority.ts draws for the human-approved release lane).
      await degradeToHumanRequired(
        intentId,
        killState.killed ? 'kill_switch_engaged' : 'agent_policy_denied',
        { reason: verdict.reason, epoch: killState.epoch },
      );
      return;
    }

    const authorized = await runAuthorizeTransaction({
      intent,
      run,
      agentId: agent.id,
      partnerId,
      key,
      killEpoch: killState.epoch,
      maxFleetPercentPerDay: current.effective.limits.maxFleetPercentPerDay,
      maxPolicyDecisionsPerDay: current.effective.limits.maxPolicyDecisionsPerDay,
    });
    if (!authorized.ok) {
      await degradeToHumanRequired(intentId, authorized.reason);
      return;
    }

    recordActionIntentEvent({
      orgId: intent.orgId,
      intentId: intent.id,
      actionName: intent.actionName,
      argumentDigest: intent.argumentDigest,
      source: intent.source,
      outcome: 'approved',
      actorType: 'ai_agent',
      initiatedBy: 'policy',
      details: {
        decidedVia: 'policy',
        agentId: agent.id,
        agentRunId: run.id,
        policyAuthorizationKey: key,
      },
    });

    await notifyRecipientsOfPolicyAuthorization({
      orgId: intent.orgId,
      partnerId,
      recipients: current.effective.recipients,
      agentName: agent.name,
      intentId: intent.id,
      targetSummary: intent.targetSummary,
    });
  } catch (err) {
    if (err instanceof PolicyDecisionRaceLostError) {
      // Someone else's attempt already won — silent no-op, not a failure.
      return;
    }
    // Everything else reaching here is TRANSIENT (a DB/Redis error from any
    // of the awaited reads/writes above): log and leave the intent
    // `unattempted` for the outbox's at-least-once redelivery to retry.
    // Never degrade to human_required on a transient fault — that would
    // permanently forfeit the policy-decide path for an intent that might
    // have authorized cleanly on the next attempt.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[policyDecide] attemptPolicyDecision transient failure for intent ${intentId} (left unattempted):`, err);
  }
}
