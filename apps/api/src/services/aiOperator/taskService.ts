/**
 * AI Operator task admission and inspection (#5205 W06), spec §5.1, §7.1.
 *
 * INTERNAL API ONLY. There is deliberately no HTTP route here: W07 shipped the
 * read routes and W08 owns the POST admission surface. Everything in this file
 * is called by the coordinator, the recipe, or a test.
 *
 * WHAT ADMISSION FREEZES (spec §7.1: "Admission pins agent identity, task
 * origin, target scope, workflow version, and an effective authorization
 * ceiling"). The frozen values live in NOT NULL columns on the task row rather
 * than only inside the checkpoint jsonb, for two reasons: a later policy
 * change must not be able to rewrite what the task was reviewed as, and every
 * frozen value that a customer must be able to export has to live in a bounded
 * `text` column (spec §11 — every jsonb column is `excludedOpen`).
 *
 *  - `agent_id` + `agent_kind` + `agent_name`: the agent as it was. A
 *    replacement same-kind agent cannot inherit the task (enforced again at
 *    every run admission, in `runService.ts`).
 *  - `workflow_key` + `workflow_version`: the recipe as released.
 *  - `device_id` + `target_label`: the target, plus a frozen display label that
 *    survives the device being moved or deleted.
 *  - `deadline_at`: NOT NULL by contract, because `dispatchClaim.ts`'s
 *    `evaluateTaskClaimPredicate` FAILS CLOSED on a null deadline ("absence of
 *    a bound is not permission"). A task admitted without one could never
 *    dispatch anything.
 *  - `checkpoint`: the recipe input and the criterion, both parsed.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiAgents } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import {
  identityOffboardingCheckpointSchema,
  identityOffboardingInputSchema,
  serviceRecoveryCheckpointSchema,
  taskCheckpointSchema,
  TASK_CHECKPOINT_VERSION,
  type IdentityOffboardingCheckpoint,
  type IdentityOffboardingInput,
  type ServiceRecoveryCheckpoint,
  type TaskCheckpoint,
  type ServiceRecoveryInput,
} from '@breeze/shared';
import {
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
} from './recipes/serviceRecovery';
import { IDENTITY_OFFBOARDING_WORKFLOW_KEY } from './recipes/identityOffboarding';
import { resolveAdmissionRecipe } from './recipes';
import type { AnyRecipeDefinition, TaskPhase } from './recipes/types';
import {
  aiOperatorIdentityOffboardingEnabled,
  aiOperatorServiceRecoveryEnabled,
  aiOperatorTasksEnabled,
} from '../../config/env';
import { admissionFenced } from './taskTransitions';
import { createTaskTarget, freezeTargetAccount, upsertContactExternalLinks } from './targetService';
import {
  createContactForTask,
  findLiveTaskForContact,
  identifyTaskPerson,
  lockContactForRecipe,
  pinContact,
  resolveProviderAccounts,
} from './contactResolution';
import { openStep, resolveStepKind } from './stepService';
import { appendTaskEvent } from './eventService';
import { resolveTaskDeadlineMs } from './taskDeadline';
import { checkTaskActiveTargets, checkTaskPendingCapacity } from './taskLimits';
import { countPendingTasks, lockOrgTaskAdmission } from './taskLimitsLoader';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';

export type AdmitTaskRefusal =
  | 'tasks_disabled'
  | 'recipe_disabled'
  /** The workflow key is not in the registry at ANY version — a 400 at the route. */
  | 'unknown_recipe'
  /** The key exists but not at the reviewed version — a 422 at the route. */
  | 'recipe_version_mismatch'
  | 'agent_not_found'
  | 'device_not_in_org'
  | 'invalid_input'
  /**
   * The org is at its `taskMaxPendingPerOrg` ceiling (#6590) — a 429 at the
   * route (spec §12's visible capacity result), not a 422: nothing about the
   * request is wrong, the org just has to finish or stop work first.
   */
  | 'pending_cap_reached'
  /** A task-wide policy ceiling other than capacity refused the task (#6590). */
  | 'task_limit_exceeded'
  /** R1a, contact-targeted recipes. A named contact is not in this org (non-enumerating 404). */
  | 'contact_not_in_org'
  /** R1a. The person could not be resolved to exactly one contact; the technician must choose. */
  | 'contact_ambiguous'
  /** R1a. Neither provider has an account for the person. */
  | 'no_provider_account'
  /** R1a. A task of this recipe is already live for this contact (409). */
  | 'duplicate_live_task';

export type AdmitTaskResult =
  /**
   * `replayed` is true when `clientIdempotencyKey` matched a task this org had
   * already admitted, so NOTHING was created by this call (W08, #5246). The
   * caller must still answer 202 with this id — a replay is a success, not a
   * conflict — but it must not treat the call as having produced new work.
   */
  | { ok: true; taskId: string; replayed: boolean }
  | { ok: false; refusal: AdmitTaskRefusal; detail: string; existingTaskId?: string };

export interface AdmitServiceRecoveryTaskInput {
  orgId: string;
  agentId: string;
  objective: string;
  originKind: 'manual' | 'alert' | 'ticket' | 'schedule' | 'anomaly' | 'sweep' | 'chat';
  requesterUserId: string | null;
  recipeInput: unknown;
  /**
   * Which recipe to admit. Defaults to the service-recovery pair, because
   * every current caller admits that one; passing them explicitly is what lets
   * the route refuse an unknown key with the registry's own message instead of
   * a zod literal mismatch. The pair is resolved against the registry and the
   * RESOLVED values are what land on the row — a caller cannot write a key the
   * coordinator could not later dispatch on.
   */
  workflowKey?: string;
  workflowVersion?: number;
  /** Override for tests; defaults to the recipe's own bound. */
  deadlineMs?: number;
  now?: Date;
  /**
   * Client-supplied admission idempotency key (spec §12), W08 (#5246).
   *
   * Unique per org via the PARTIAL unique index
   * `ai_operator_tasks_client_idempotency_uq`. Re-admitting with a key this
   * org has already used returns that task's id and inserts nothing, which is
   * what stops a double-clicked "Delegate to Operator" from dispatching two
   * service restarts to the same machine. Null (the default) means "no
   * idempotency" and is what every internal admission passes.
   */
  clientIdempotencyKey?: string | null;
  /**
   * Wisp W02 (Wisp design §4.3) — TRUSTED INTERNAL INPUT: the delegation grant
   * + revision a Wisp-launched task runs under. W07's coordinator is the
   * producer; `routes/aiOperatorTasks.ts` does not expose it. The requester
   * gate then checks the live ceiling (with the effect permission) before
   * each effect, and the coordinator's runs inherit the pin.
   */
  grant?: { grantId: string; grantRevisionId: string };
}

/**
 * Each recipe's feature flag, nested under `AI_OPERATOR_TASKS_ENABLED`. A
 * third recipe adds one line. A registered recipe with NO entry cannot be
 * admitted (fail closed).
 *
 * The accessors are wrapped, never referenced bare: reading an env accessor
 * at module load would make every importer of this file depend on it.
 */
export const RECIPE_FLAGS: Readonly<Record<string, { name: string; enabled: () => boolean }>> = Object.freeze({
  [SERVICE_RECOVERY_WORKFLOW_KEY]: {
    name: 'AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED',
    enabled: () => aiOperatorServiceRecoveryEnabled(),
  },
  [IDENTITY_OFFBOARDING_WORKFLOW_KEY]: {
    name: 'AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED',
    enabled: () => aiOperatorIdentityOffboardingEnabled(),
  },
});

/** True when tasks are on AND the recipe's own flag is on. Read at call time. */
export function recipeEnabled(recipeKey: string): boolean {
  const flag = Object.hasOwn(RECIPE_FLAGS, recipeKey) ? RECIPE_FLAGS[recipeKey] : undefined;
  return aiOperatorTasksEnabled() && flag !== undefined && flag.enabled();
}

/**
 * Admit one service-recovery task — the shipped entry point, unchanged.
 *
 * Kept as a named export rather than folded into `admitTask` because two
 * shipped suites mock it by name (`routes/aiOperatorTasks.test.ts`,
 * `__tests__/integration/aiOperatorAdmission.integration.test.ts`). It is a
 * projection, not a second path: every rule lives in `admitTask`.
 *
 * It admits `service_recovery` and nothing else. Since R1a the registry holds
 * a second recipe; a caller naming it HERE gets the refusal it got before that
 * recipe existed (after the same two flag checks, in the same order), never a
 * service-recovery-shaped admission under another recipe's key.
 */
export async function admitServiceRecoveryTask(
  input: AdmitServiceRecoveryTaskInput,
): Promise<AdmitTaskResult> {
  if (input.workflowKey !== undefined && input.workflowKey !== SERVICE_RECOVERY_WORKFLOW_KEY) {
    if (!aiOperatorTasksEnabled()) {
      return { ok: false, refusal: 'tasks_disabled', detail: 'AI_OPERATOR_TASKS_ENABLED is off' };
    }
    if (!aiOperatorServiceRecoveryEnabled()) {
      return { ok: false, refusal: 'recipe_disabled', detail: 'AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED is off' };
    }
    return {
      ok: false,
      refusal: 'unknown_recipe',
      detail: `'${input.workflowKey}' is not a supported workflow for service-recovery admission. `
        + `Supported workflows: ${SERVICE_RECOVERY_WORKFLOW_KEY}.`,
    };
  }
  return admitTask({
    ...input,
    workflowKey: SERVICE_RECOVERY_WORKFLOW_KEY,
    workflowVersion: input.workflowVersion ?? SERVICE_RECOVERY_WORKFLOW_VERSION,
  });
}

export interface AdmitTaskInput {
  orgId: string;
  agentId: string;
  objective: string;
  originKind: AdmitServiceRecoveryTaskInput['originKind'];
  requesterUserId: string | null;
  workflowKey: string;
  workflowVersion: number;
  recipeInput: unknown;
  deadlineMs?: number;
  now?: Date;
  clientIdempotencyKey?: string | null;
  /** Wisp W02 grant pin; see `AdmitServiceRecoveryTaskInput.grant`. */
  grant?: AdmitServiceRecoveryTaskInput['grant'];
}

type Refusal = Extract<AdmitTaskResult, { ok: false }>;
const refuse = (refusal: AdmitTaskRefusal, detail: string, extra: { existingTaskId?: string } = {}): Refusal =>
  ({ ok: false, refusal, detail, ...extra });

/**
 * How one recipe's targets are resolved and written. The gate skeleton in
 * `admitTask` is shared; only these four seams differ per recipe.
 */
interface AdmissionTargets {
  /** In the transaction, before the limits: resolve and count the targets. */
  resolve(): Promise<Refusal | { targetCount: number }>;
  /** In the transaction, after the deadline is known and before the insert. */
  beforeInsert(deadlineAt: Date): Promise<Refusal | null>;
  /** The per-recipe columns of the task row. */
  row(): {
    deviceId: string | null;
    targetLabel: string;
    phase: TaskPhase;
    currentStepKey: string;
    checkpoint: TaskCheckpoint;
  };
  /** In the transaction, only when the row was inserted. */
  afterInsert(taskId: string): Promise<void>;
}

/**
 * Admit one task for any registered recipe (Recipe Library W06 R1a; E1
 * decision 7 deferred this to the second recipe).
 *
 * Both feature flags are checked here and NOT in the coordinator's
 * reconciliation path, which is the whole distinction spec §11.2 draws: "the
 * existing AI kill switches fence new admissions and dispatch claims; the
 * publisher and reconciler keep running so late results still land." Turning
 * a recipe off must stop new tasks, never abandon one whose effect is already
 * out.
 *
 * THE SHIPPED GATES, IN THE SHIPPED ORDER: flags → recipe resolution → input
 * parse → (one transaction) agent → targets → policy limits →
 * `task_limit_exceeded` → `lockOrgTaskAdmission` → idempotent replay →
 * `pending_cap_reached` → jittered deadline → insert. A contact-targeted
 * recipe resolves its person and provider accounts BEFORE the transaction
 * (provider reads never run under admission locks) and inserts its own steps
 * after the deadline: cutoff ≤ deadline, contact pin/create, the per-(recipe,
 * contact) advisory lock, and the one-live-task refusal.
 */
export async function admitTask(input: AdmitTaskInput): Promise<AdmitTaskResult> {
  if (!aiOperatorTasksEnabled()) {
    return { ok: false, refusal: 'tasks_disabled', detail: 'AI_OPERATOR_TASKS_ENABLED is off' };
  }
  const flag = Object.hasOwn(RECIPE_FLAGS, input.workflowKey) ? RECIPE_FLAGS[input.workflowKey] : undefined;
  if (flag && !flag.enabled()) {
    return { ok: false, refusal: 'recipe_disabled', detail: `${flag.name} is off` };
  }

  // Resolve BEFORE the input parse and before any db work. An unknown workflow
  // cannot be admitted regardless of what the org contains, and reaching
  // Postgres to discover that would hold a connection for a request that can
  // never succeed.
  const resolution = resolveAdmissionRecipe(input.workflowKey, input.workflowVersion);
  if (!resolution.ok) {
    return {
      ok: false,
      refusal: resolution.reason === 'unknown_recipe' ? 'unknown_recipe' : 'recipe_version_mismatch',
      detail: resolution.detail,
    };
  }
  const recipe = resolution.recipe;
  if (!flag) {
    return { ok: false, refusal: 'recipe_disabled', detail: `workflow '${recipe.key}' has no feature flag and cannot be admitted` };
  }

  // Wisp W02: a delegation grant is one person's borrowed authority; the
  // requester gate re-checks that person before every effect, so a grant
  // without its requester has nothing to re-check against.
  if (input.grant && !input.requesterUserId) {
    return { ok: false, refusal: 'invalid_input', detail: 'a grant-bearing task needs its requester (the grantor)' };
  }

  const now = input.now ?? new Date();
  let targets: AdmissionTargets;
  if (recipe.key === SERVICE_RECOVERY_WORKFLOW_KEY) {
    let recipeInput: ServiceRecoveryInput;
    try {
      recipeInput = parseServiceRecoveryInput(input.recipeInput);
    } catch (error) {
      return {
        ok: false,
        refusal: 'invalid_input',
        detail: error instanceof Error ? error.message.slice(0, 400) : 'invalid recipe input',
      };
    }
    targets = serviceRecoveryTargets(input, recipe, recipeInput);
  } else if (recipe.key === IDENTITY_OFFBOARDING_WORKFLOW_KEY) {
    const parsed = identityOffboardingInputSchema.safeParse(input.recipeInput);
    if (!parsed.success) {
      return {
        ok: false,
        refusal: 'invalid_input',
        detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ').slice(0, 400),
      };
    }
    const prepared = await prepareContactTargets(input, recipe, parsed.data);
    if ('refusal' in prepared) return prepared;
    targets = prepared;
  } else {
    // A registered recipe this admission has no target plan for.
    return { ok: false, refusal: 'unknown_recipe', detail: `workflow '${recipe.key}' cannot be admitted by this build` };
  }

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // The agent must exist AND be in this org. `ai_operator_tasks.agent_id`
      // is a plain FK with no composite same-org key on purpose (spec §11.3 —
      // `ai_agents` rows are REPOINTED to the survivor on org merge while a
      // task's `org_id` is immutable, so a composite FK would abort the
      // merge). That makes this check the only thing standing between a task
      // and an agent in another tenant.
      const [agent] = await db
        .select({ id: aiAgents.id, kind: aiAgents.kind, name: aiAgents.name, orgId: aiAgents.orgId })
        .from(aiAgents)
        .where(eq(aiAgents.id, input.agentId))
        .limit(1);
      if (!agent || (agent.orgId !== null && agent.orgId !== input.orgId)) {
        return {
          ok: false as const,
          refusal: 'agent_not_found' as const,
          detail: `agent ${input.agentId} is not available to org ${input.orgId}`,
        };
      }

      const resolvedTargets = await targets.resolve();
      if ('refusal' in resolvedTargets) return resolvedTargets;

      const taskId = randomUUID();

      // v15 task-wide budget `taskDeadlineHours` (recipe library E2, #6167):
      // the recipe bound and any caller-requested deadline are both capped by
      // the EFFECTIVE agent policy's ceiling. We are already inside a system
      // context, so resolveEffectiveAgentSystem reads straight through on
      // this connection. The effective agent must be the one being pinned;
      // if the org has since replaced it, the pinned agent's first run
      // admission refuses with ownership_mismatch anyway, and the default
      // ceiling applies here rather than a stranger's policy.
      const effectiveAgent = await resolveEffectiveAgentSystem(input.orgId, agent.kind as never);
      const policyLimits = effectiveAgent && effectiveAgent.agentId === agent.id
        ? effectiveAgent.effective.limits
        : null;

      // v15 task-wide budget `taskMaxActiveTargets` (#6590).
      const targetsCheck = checkTaskActiveTargets({ targetCount: resolvedTargets.targetCount, policyLimits });
      if (!targetsCheck.ok) {
        return { ok: false as const, refusal: 'task_limit_exceeded' as const, detail: targetsCheck.detail };
      }

      const clientIdempotencyKey = input.clientIdempotencyKey ?? null;

      // v15 task-wide budget `taskMaxPendingPerOrg` (#6590, spec §7.2/§12).
      // The per-org advisory lock makes count-then-insert one decision for
      // the rest of this transaction; without it concurrent admissions all
      // read `cap - 1` and all insert.
      await lockOrgTaskAdmission(input.orgId);

      // An idempotent replay creates nothing, so it must not be refused for
      // capacity: answer it before counting. (Under the lock, so the winner
      // of a concurrent same-key race is already committed and visible here;
      // the ON CONFLICT path below stays as the backstop.)
      if (clientIdempotencyKey !== null) {
        const [prior] = await db
          .select({ id: aiOperatorTasks.id })
          .from(aiOperatorTasks)
          .where(and(
            eq(aiOperatorTasks.orgId, input.orgId),
            eq(aiOperatorTasks.clientIdempotencyKey, clientIdempotencyKey),
          ))
          .limit(1);
        if (prior) return { ok: true as const, taskId: prior.id, replayed: true };
      }

      const pendingCheck = checkTaskPendingCapacity({
        pendingCount: await countPendingTasks(input.orgId),
        policyLimits,
      });
      if (!pendingCheck.ok) {
        return { ok: false as const, refusal: 'pending_cap_reached' as const, detail: pendingCheck.detail };
      }

      const deadlineMs = resolveTaskDeadlineMs({
        requestedMs: input.deadlineMs,
        recipeDeadlineMs: recipe.bounds.deadlineMs,
        policyLimits,
        // ±10% jitter (spec §11.2) so a burst of tasks admitted together does
        // not create an expiry wave 24 hours later.
        jitter: () => 0.9 + Math.random() * 0.2,
      });
      // Already jittered and capped by resolveTaskDeadlineMs above.
      const deadlineAt = new Date(now.getTime() + deadlineMs);

      const blocked = await targets.beforeInsert(deadlineAt);
      if (blocked) return blocked;

      const row = targets.row();
      const inserted = await db
        .insert(aiOperatorTasks)
        .values({
        id: taskId,
        orgId: input.orgId,
        agentId: agent.id,
        agentKind: agent.kind,
        agentName: agent.name,
        // The RESOLVED pair, not the requested one: the row must always name a
        // recipe `getRecipe` can return, or the coordinator's first tick on it
        // would hand the task off (Operator spec P3-4, version frozen for life).
        workflowKey: recipe.key,
        workflowVersion: recipe.version,
        mode: 'live',
        originKind: input.originKind,
        requesterUserId: input.requesterUserId,
        // Wisp W02: both or none (`ai_operator_tasks_grant_link_chk`).
        grantId: input.grant?.grantId ?? null,
        grantRevisionId: input.grant?.grantRevisionId ?? null,
        objective: input.objective.slice(0, 4000),
        deviceId: row.deviceId,
        targetLabel: row.targetLabel,
        state: 'queued',
        phase: row.phase,
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        currentStepKey: row.currentStepKey,
        checkpoint: row.checkpoint as unknown as Record<string, unknown>,
        deadlineAt,
        // Due immediately. The coordinator's `queued_past_wake` scan is what
        // picks it up — admission does NOT enqueue a wake job, because a queued
        // task has no authoritative source row to re-derive a wake FROM, which
        // is the property spec §6.3 requires of every outbox row.
        nextWakeAt: now,
        // The root of its own accounting tree (spec §6.1: "root has no root
        // pointer"), left null rather than self-referencing.
        accountingRootTaskId: null,
        clientIdempotencyKey,
        })
        // W08 (#5246). `DO NOTHING` rather than catching 23505: a unique
        // violation ABORTS the surrounding transaction, so the read-back
        // needed to answer with the winner's id could not run in it. Letting
        // Postgres swallow the conflict keeps the transaction alive and makes
        // the replay read a plain follow-up statement. The conflict target
        // must repeat the index's WHERE clause, or Postgres cannot match the
        // PARTIAL index and raises 42P10 instead of deduplicating.
        .onConflictDoNothing({
          target: [aiOperatorTasks.orgId, aiOperatorTasks.clientIdempotencyKey],
          where: sql`client_idempotency_key IS NOT NULL`,
        })
        .returning({ id: aiOperatorTasks.id });

      if (inserted.length > 0) {
        // Inside the SAME transaction as the task insert (this callback is one
        // withSystemDbAccessContext transaction and the bare `db` proxy joins
        // it), and ONLY on this branch: the idempotent-replay branch below did
        // not create the task, and writing a second target/step/event for a
        // task another request already admitted is exactly the duplicate the
        // client idempotency key exists to prevent.
        await targets.afterInsert(taskId);
        return { ok: true as const, taskId, replayed: false };
      }

      // Nothing inserted => the partial unique index rejected it, which can
      // only happen when this org already holds a task under this key. Read
      // the winner. Scoped by BOTH org and key: the index is org-scoped, and
      // a key-only lookup would hand one tenant another tenant's task id.
      const [existing] = await db
        .select({ id: aiOperatorTasks.id })
        .from(aiOperatorTasks)
        .where(
          and(
            eq(aiOperatorTasks.orgId, input.orgId),
            eq(aiOperatorTasks.clientIdempotencyKey, clientIdempotencyKey as string),
          ),
        )
        .limit(1);

      if (!existing) {
        // A conflict fired but the row it must point at is not there. Nothing
        // in the caller's request can cause this — the index is org+key scoped
        // and so is this read — so it is a broken invariant (a concurrent
        // erasure racing admission, or a future change that desynchronises the
        // index from this lookup), never a client-format problem.
        //
        // THROW rather than refuse: a refusal would be reclassified by the
        // route as a 422 that reads to the technician as "your input was
        // wrong", and would leave no trace anywhere for anyone to investigate
        // the actual consistency break. Same convention as
        // `operationService.ts`'s dispatch-claim cardinality check. The key
        // itself is caller-supplied and never logged.
        throw new Error(
          `[aiOperator] admission conflicted on the client idempotency key but no existing task was found for org ${input.orgId}`,
        );
      }

      return { ok: true as const, taskId: existing.id, replayed: true };
    }));
}

/** `service_recovery`: one device target, exactly the shipped writes. */
function serviceRecoveryTargets(
  input: AdmitTaskInput,
  recipe: AnyRecipeDefinition,
  recipeInput: ServiceRecoveryInput,
): AdmissionTargets {
  const criterion = buildServiceRecoveryCriterion(recipeInput);
  // Admission builds the service-recovery ARM explicitly (R1a-0): the union
  // would accept it too, but the type here is the arm, not the union.
  const checkpoint: ServiceRecoveryCheckpoint = serviceRecoveryCheckpointSchema.parse({
    version: TASK_CHECKPOINT_VERSION,
    recipeInput,
    criterion,
    findings: [],
    satisfiedCriteria: [],
    unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0,
    lastVerification: null,
    lastOperationKey: null,
    fixWatchId: null,
  });
  let device: { id: string; hostname: string | null } | null = null;
  return {
    async resolve() {
      const [found] = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(and(eq(devices.id, recipeInput.deviceId), eq(devices.orgId, input.orgId)))
        .limit(1);
      if (!found) return refuse('device_not_in_org', `device ${recipeInput.deviceId} is not in org ${input.orgId}`);
      device = found;
      // Admission writes exactly one target, and the validator's floor is 1,
      // so no valid policy refuses here today; the check exists so the fleet
      // waves inherit an enforced ceiling instead of a comment.
      return { targetCount: 1 };
    },
    async beforeInsert() { return null; },
    row() {
      return {
        deviceId: device!.id,
        targetLabel: (device!.hostname ?? recipeInput.deviceId).slice(0, 255),
        phase: 'investigate',
        currentStepKey: 'investigate',
        checkpoint,
      };
    },
    async afterInsert(taskId) {
      // Wave E2 (#6167). The target row is the identity; the inline
      // device_id / target_label columns written above stay as the read
      // projection recipe spec §5.5 keeps until P3-5. BOTH are written,
      // deliberately — this wave is additive, and every existing reader of
      // the inline columns keeps working unchanged.
      const target = await createTaskTarget(db, {
        orgId: input.orgId,
        taskId,
        targetKind: 'device',
        deviceId: device!.id,
        targetLabel: (device!.hostname ?? recipeInput.deviceId).slice(0, 255),
        targetOrdinal: 0,
      });
      await openStep(db, {
        orgId: input.orgId,
        taskId,
        stepKey: 'investigate',
        stepKind: resolveStepKind(recipe.key, recipe.version, 'investigate'),
        targetId: target.id,
        attemptOrdinal: 0,
        planRevision: 1,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
      // ONE event for the whole admission, not three. `createTaskTarget` and
      // `openStep` are called without an `actor` above precisely so they do
      // not each write their own — an admission is one transition.
      await appendTaskEvent(db, {
        orgId: input.orgId,
        taskId,
        eventType: 'task_admitted',
        actor: input.requesterUserId
          ? { kind: 'user', userId: input.requesterUserId }
          : { kind: 'system' },
        stepKey: 'investigate',
        targetId: target.id,
        detail: `${recipe.key} v${recipe.version} admitted against device target ${target.id}`,
      });
    },
  };
}

/**
 * `identity_offboarding`: a contact target (ordinal 0), one device target per
 * selected device, and the person's provider accounts frozen onto the contact
 * target. The person and the accounts are resolved HERE, before the
 * transaction; nothing here writes until the transaction.
 */
async function prepareContactTargets(
  input: AdmitTaskInput,
  recipe: AnyRecipeDefinition,
  recipeInput: IdentityOffboardingInput,
): Promise<AdmissionTargets | Refusal> {
  const person = await identifyTaskPerson(input.orgId, {
    contactId: recipeInput.contactId, personHint: recipeInput.personHint,
  });
  if (!person.ok) {
    return refuse(person.reason === 'contact_not_in_org' ? 'contact_not_in_org' : 'contact_ambiguous', person.detail);
  }
  const { accounts, problems } = await resolveProviderAccounts(input.orgId, {
    contactId: person.kind === 'existing' ? person.contactId : null,
    email: person.email,
    label: person.label,
  });
  if (accounts.length === 0) {
    return refuse('no_provider_account',
      `no Microsoft 365 or Google Workspace account was found for ${person.label}`
        + (problems.length > 0 ? ` (${problems.join('; ')})` : ''));
  }

  const entryStepKey = recipe.entryStepKey ?? 'investigate';
  const phase = recipe.steps[entryStepKey]?.phase ?? 'investigate';
  const checkpoint: IdentityOffboardingCheckpoint = identityOffboardingCheckpointSchema.parse({
    version: TASK_CHECKPOINT_VERSION,
    recipeInput,
    // An account WAS found, so the task runs — but a provider whose lookup
    // failed is a gap the technician must see, not a provider quietly skipped.
    admissionProblems: problems.slice(0, 10).map((p) => p.slice(0, 500)),
  });
  let contactId: string | null = person.kind === 'existing' ? person.contactId : null;
  let selected: Array<{ id: string; hostname: string | null }> = [];

  return {
    async resolve() {
      if (recipeInput.deviceIds.length > 0) {
        const rows = await db
          .select({ id: devices.id, hostname: devices.hostname })
          .from(devices)
          .where(and(eq(devices.orgId, input.orgId), inArray(devices.id, recipeInput.deviceIds)))
          .limit(recipeInput.deviceIds.length);
        const found = new Set(rows.map((r) => r.id));
        const missing = recipeInput.deviceIds.filter((d) => !found.has(d));
        if (missing.length > 0) return refuse('device_not_in_org', `device ${missing[0]} is not in org ${input.orgId}`);
        // In the order the technician selected them, so target ordinals are stable.
        selected = recipeInput.deviceIds.map((d) => rows.find((r) => r.id === d)!);
      }
      // `taskMaxActiveTargets` counts the targets an EFFECT can act on. Only
      // the contact is one: selected devices carry no effect in this recipe
      // (each becomes a manual item, D2), so they are reference targets — kept
      // for the requester gate and the completion record, not counted. The
      // default policy ceiling is 1, which would otherwise refuse every
      // offboarding that names a laptop.
      return { targetCount: 1 };
    },
    async beforeInsert(deadlineAt) {
      // A cutoff after the deadline could never dispatch: refuse it now.
      if (recipeInput.cutoffAt && new Date(recipeInput.cutoffAt).getTime() > deadlineAt.getTime()) {
        return refuse('invalid_input',
          `cutoffAt ${recipeInput.cutoffAt} is after this task's deadline ${deadlineAt.toISOString()}`);
      }
      if (person.kind === 'existing') {
        if (!(await pinContact(input.orgId, person.contactId))) {
          return refuse('contact_not_in_org', 'contact not found in this organization');
        }
      } else {
        const created = await createContactForTask(input.orgId, person.email, input.requesterUserId);
        if (!created.ok) return refuse('contact_ambiguous', created.detail);
        contactId = created.contactId;
      }
      // D-R1-6: one live task per (contact, recipe), serialized by a
      // transaction-scoped advisory lock taken AFTER the org admission lock.
      await lockContactForRecipe(input.orgId, recipe.key, contactId!);
      const live = await findLiveTaskForContact(input.orgId, recipe.key, contactId!);
      if (live) {
        return refuse('duplicate_live_task', `a ${recipe.key} task is already live for this contact: ${live.taskId}`,
          { existingTaskId: live.taskId });
      }
      return null;
    },
    row() {
      return {
        deviceId: null,
        targetLabel: person.label.slice(0, 255),
        phase,
        currentStepKey: entryStepKey,
        checkpoint,
      };
    },
    async afterInsert(taskId) {
      const contactTarget = await createTaskTarget(db, {
        orgId: input.orgId, taskId, targetKind: 'contact', contactId: contactId!,
        targetLabel: person.label.slice(0, 255), targetOrdinal: 0,
      });
      for (const [i, device] of selected.entries()) {
        await createTaskTarget(db, {
          orgId: input.orgId, taskId, targetKind: 'device', deviceId: device.id,
          targetLabel: (device.hostname ?? device.id).slice(0, 255), targetOrdinal: i + 1,
        });
      }
      for (const account of accounts) {
        await freezeTargetAccount(db, {
          orgId: input.orgId, taskId, targetId: contactTarget.id, provider: account.provider,
          connectionId: account.connectionId, externalId: account.externalId, principalLabel: account.principalLabel,
        });
      }
      const newLinks = accounts.filter((a) => !a.fromLink).map((a) => ({ system: a.provider, externalId: a.externalId }));
      if (newLinks.length > 0) {
        await upsertContactExternalLinks(db, { orgId: input.orgId, contactId: contactId!, links: newLinks });
      }
      await openStep(db, {
        orgId: input.orgId,
        taskId,
        stepKey: entryStepKey,
        stepKind: resolveStepKind(recipe.key, recipe.version, entryStepKey),
        targetId: contactTarget.id,
        attemptOrdinal: 0,
        planRevision: 1,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
      await appendTaskEvent(db, {
        orgId: input.orgId,
        taskId,
        eventType: 'task_admitted',
        actor: input.requesterUserId ? { kind: 'user', userId: input.requesterUserId } : { kind: 'system' },
        stepKey: entryStepKey,
        targetId: contactTarget.id,
        detail: `${recipe.key} v${recipe.version} admitted against contact target ${contactTarget.id}`
          + ` (${selected.length} device target(s), ${accounts.map((a) => a.provider).join('+')} account(s) frozen)`,
      });
    },
  };
}

/** The task-row fields a fence check needs. */
export interface TaskFence {
  state: string;
  revision: number;
  leaseEpoch: number;
  deadlineAt: Date | null;
  targetDetachedAt: Date | null;
  /** True when NEW reasoning or NEW effects must be refused (spec §7.3). */
  fenced: boolean;
}

/**
 * Whether a task in this shape must refuse NEW reasoning and NEW effects
 * (spec §7.3), as a PURE function.
 *
 * Extracted from `loadTaskFence` so the predicate is exhaustively testable
 * without a database — it is the check the run loop's pre-tool hook makes on
 * every single tool call, and the consequence of getting it wrong is a
 * cancelled or expired task whose in-flight run keeps proposing effects.
 * Three independent reasons, any one of which fences:
 *
 *  1. the state itself (`paused`, `stopping`, or any terminal state);
 *  2. the target is detached — the device moved org or was deleted, so the
 *     frozen scope no longer resolves to anything this task may touch;
 *  3. the deadline has passed. Fenced from the INSTANT it passes, not from
 *     the instant a poller notices: spec §7.3 says expiry "stops new effects
 *     like cancellation", and a reconciler tick is up to 15 seconds away.
 *
 * A null `deadlineAt` does NOT fence here, deliberately: admission always sets
 * one, and the place that fails closed on its absence is the dispatch claim
 * (`evaluateTaskClaimPredicate`, "absence of a bound is not permission"),
 * which is the linearization point. Fencing on it here as well would only
 * change which of the two refuses first.
 */
export function isTaskFenced(
  task: { state: string; targetDetachedAt: Date | null; deadlineAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (admissionFenced(task.state)) return true;
  if (task.targetDetachedAt !== null) return true;
  return task.deadlineAt !== null && task.deadlineAt.getTime() <= now.getTime();
}

/**
 * Read the fence state of a task.
 *
 * Used by the run loop's pre-tool hook: spec §7.3 says a cancelled task
 * "fences its in-flight run at the next tool call and lets it finish", because
 * there is no run-level cancel in this codebase at all (baseline C17 —
 * `cancelled`/`expired` are valid `ai_agent_runs` statuses with zero
 * production writers and no route). The fence IS the cancel.
 *
 * Deliberately a plain read with no lock: the pre-hook is on the model's
 * critical path, and a task that transitions to `stopping` one microsecond
 * after this read is handled by the DISPATCH claim, which does take the row
 * `FOR UPDATE`. This check is an early, cheap refusal, not the linearization
 * point — spec §7.3 is explicit that the claim is the linearization point.
 */
export async function loadTaskFence(orgId: string, taskId: string): Promise<TaskFence | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          state: aiOperatorTasks.state,
          revision: aiOperatorTasks.revision,
          leaseEpoch: aiOperatorTasks.leaseEpoch,
          deadlineAt: aiOperatorTasks.deadlineAt,
          targetDetachedAt: aiOperatorTasks.targetDetachedAt,
        })
        .from(aiOperatorTasks)
        .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, orgId)))
        .limit(1);
      if (!row) return null;
      const state = row.state as string;
      return {
        state,
        revision: row.revision,
        leaseEpoch: row.leaseEpoch,
        deadlineAt: row.deadlineAt ?? null,
        targetDetachedAt: row.targetDetachedAt ?? null,
        fenced: isTaskFenced({
          state,
          targetDetachedAt: row.targetDetachedAt ?? null,
          deadlineAt: row.deadlineAt ?? null,
        }),
      };
    }));
}

/**
 * Parse a stored checkpoint.
 *
 * Returns the reason on failure rather than a bare `null`: the only caller
 * TERMINALIZES the task on a parse failure, and doing that with the detail
 * `'task checkpoint does not conform to the current schema'` and nothing else
 * leaves whoever has to debug it with no field, no value and no way to tell a
 * schema migration from a corrupt write.
 */
export function parseTaskCheckpointResult(
  value: unknown,
): { ok: true; checkpoint: TaskCheckpoint } | { ok: false; detail: string } {
  const parsed = taskCheckpointSchema.safeParse(value);
  if (parsed.success) return { ok: true, checkpoint: parsed.data };
  // Describe EVERY arm from its own parse, not from the union's error: zod
  // reports a union mismatch either as one root `invalid_union` or as the
  // single arm it judges "non-aborted", and that judgement shifts between zod
  // releases (4.6 picks the identity arm for a service-recovery row missing
  // its criterion, dropping the real problem). The arm with the fewest issues
  // leads (ties keep arm order), so the 400-char cap cuts the farther arms.
  const perArm = taskCheckpointSchema.options
    .map((arm) => arm.safeParse(value))
    .map((r) => (r.success ? [] : describeCheckpointIssues(r.error.issues, [])))
    .filter((lines) => lines.length > 0)
    .sort((a, b) => a.length - b.length);
  return {
    ok: false,
    detail: perArm.flat().join('; ').slice(0, 400),
  };
}

/**
 * `taskCheckpointSchema` is a union of per-recipe arms (R1a-0). A mismatch
 * reported as a single `invalid_union` issue at the root would replace
 * "recipeInput.serviceName: too small" with "(root): Invalid input" — the one
 * forensic trail a terminalized task has. Expand a (nested) union's arms
 * instead, with their full paths.
 */
type CheckpointIssue = { path: PropertyKey[]; message: string; code?: string; errors?: CheckpointIssue[][] };
function describeCheckpointIssues(issues: readonly CheckpointIssue[], prefix: PropertyKey[]): string[] {
  return issues.flatMap((i) => {
    const path = [...prefix, ...i.path];
    if (i.code === 'invalid_union' && Array.isArray(i.errors) && i.errors.length > 0) {
      return i.errors.flatMap((arm) => describeCheckpointIssues(arm, path));
    }
    return [`${path.map(String).join('.') || '(root)'}: ${i.message}`];
  });
}

/** Convenience wrapper for callers that only need the value. */
export function parseTaskCheckpoint(value: unknown): TaskCheckpoint | null {
  const parsed = parseTaskCheckpointResult(value);
  return parsed.ok ? parsed.checkpoint : null;
}
