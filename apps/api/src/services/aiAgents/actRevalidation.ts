/**
 * Wave 4 Part B — act-mode revalidation + action reservation (Task 3, #3826).
 *
 * `resolveActOperation` (actManifest.ts) decides SHAPE only, synchronously,
 * with no I/O — it is called from `checkAgentGuardrails` on every tool
 * dispatch and can only see the tool name + the input the model already sent.
 * `revalidateActExecution` is the I/O half the manifest's own docstring
 * promises: it runs immediately before dispatch, in the run-loop's pre-tool-use
 * hook, and re-checks everything against LIVE state — the live policy (an
 * operator may have disabled the agent, narrowed the allowlist, or dropped
 * mode back to shadow since the run started), the run's OWN device (never
 * trust the model's device argument twice), and the op's own asset (does a
 * disk-cleanup preview plan still exist for these paths, is the script's
 * content still readable, is the playbook still a built-in).
 *
 * A manifest match is therefore NECESSARY but never SUFFICIENT for execution
 * — every real execution passes through both this module and `checkAgentGuardrails`
 * TWICE (once when the model called the tool, again here against live state).
 *
 * DENY vs DOWNGRADE, precisely:
 *   - `downgrade: 'propose'` — the call is still legitimate for the agent to
 *     make, but not eligible to execute unattended RIGHT NOW (mode drifted
 *     act → shadow, the live guardrail re-run itself would only propose it,
 *     or the run's `maxActionsPerRun` reservation is exhausted). Falls into
 *     the exact same recording path shadow mode uses — a human still sees it.
 *   - `deny` — a genuine safety violation: the agent is disabled/off/kill-
 *     switched, the run's device no longer matches the call's device
 *     argument, or the op's asset failed to pin (an unreadable script, no
 *     matching disk-cleanup preview, a non-built-in playbook). Fail CLOSED,
 *     never silently downgraded to a proposal that would re-surface the same
 *     unsafe target.
 *
 * Global Constraints (plan header): drift act → shadow converts to a
 * PROPOSAL; disabled/off/kill-switch/protected/out-of-scope → DENY, never a
 * proposal. This module is where that distinction is actually drawn.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AiAgentKind } from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { deviceFilesystemCleanupRuns } from '../../db/schema/filesystem';
import { playbookDefinitions } from '../../db/schema/playbooks';
import { organizations } from '../../db/schema/orgs';
import { aiUnattendedExposure } from '../../db/schema/aiUnattendedExposure';
import { readPlanPreviewCandidates } from '../filesystemAnalysis';
import { computeEffectDigestForRelease } from '../actionIntents/effectDigest';
import { checkAgentGuardrails, type AgentGuardrailPolicy } from '../aiGuardrails';
import { readAiKillState } from '../aiKillState';
import { policyDecideEnabled } from '../../config/env';
import { countContractDevices } from '../contractQuantities';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import type { ActOperation, ActTarget } from './actManifest';
import type { ToolExecutionContext } from '../toolExecutionContext';

/**
 * Same skip-if-already-system shape as `runLoop.ts`'s own `inSystemDbContext`
 * — duplicated locally rather than imported, matching the convention every
 * other leaf module in this directory already follows (executionLedger.ts,
 * runFinishedNotify.ts).
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * v1 byte bound for an unattended `disk_cleanup.execute` (plan header, Task
 * 3 contract). Exported so the revalidation test suite can assert the exact
 * number rather than hardcoding a second copy of it.
 */
export const ACT_DISK_CLEANUP_MAX_BYTES_V1 = 5 * 1024 * 1024 * 1024;

/** In-run counter shared across every act-mode call in ONE run — a plain
 *  mutable object, not a DB row: a run is executed by exactly one BullMQ
 *  worker process at a time, so there is no cross-process race to guard. */
export interface ActReservationState {
  count: number;
}

/**
 * What survives revalidation, handed to the post-hook (Task 4) so it can
 * verify against the SAME identity that was actually authorized — never a
 * re-read of the model's original (unrevalidated) input.
 */
export interface ActAssetPin {
  op: ActOperation;
  target: ActTarget;
  /** run_script only — the pinned content this call executes from, threaded
   *  through to `executeTool`'s `ToolExecutionContext` exactly like an
   *  approved intent's release path does (see `verifiedRunScriptFor`). */
  toolExecutionContext?: ToolExecutionContext;
  /** execute_playbook only — the built-in definition's content digest AT
   *  REVALIDATION TIME, carried for Task 5's executor to re-hash and compare
   *  against at actual execution time (abort on mismatch). */
  playbookDigest?: string;
}

export type ActRevalidationResult =
  | { ok: true; pin: ActAssetPin }
  | { ok: false; downgrade: 'propose'; reason?: string }
  | { ok: false; deny: string };

export interface RevalidateActExecutionArgs {
  run: {
    id: string;
    orgId: string;
    agentId: string;
    agentKind: AiAgentKind;
    /** Act mode is single-device (Global Constraints); always non-null by
     *  the time a caller reaches this — a device-less mutation is denied far
     *  upstream, inside `checkAgentGuardrails` itself. */
    deviceId: string;
    deviceSiteId: string | null;
  };
  op: ActOperation;
  toolName: string;
  input: Record<string, unknown>;
  reserved: ActReservationState;
}

function readEstimatedBytes(plan: unknown): number {
  const preview = (plan as { preview?: { estimatedBytes?: unknown } } | null | undefined)?.preview;
  const raw = preview?.estimatedBytes;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
}

type PinStepResult =
  | { ok: true; extra: Omit<ActAssetPin, 'op' | 'target'> }
  | { ok: false; downgrade: 'propose' }
  | { ok: false; deny: string };

async function pinDiskCleanup(
  target: Extract<ActTarget, { kind: 'disk_cleanup' }>,
  run: RevalidateActExecutionArgs['run'],
): Promise<PinStepResult> {
  return inSystemDbContext(async () => {
    const [latest] = await db
      .select({ plan: deviceFilesystemCleanupRuns.plan })
      .from(deviceFilesystemCleanupRuns)
      .where(and(
        eq(deviceFilesystemCleanupRuns.deviceId, run.deviceId),
        eq(deviceFilesystemCleanupRuns.orgId, run.orgId),
        eq(deviceFilesystemCleanupRuns.status, 'previewed'),
      ))
      .orderBy(desc(deviceFilesystemCleanupRuns.createdAt))
      .limit(1);

    if (!latest) {
      return { ok: false, deny: 'No disk-cleanup preview plan exists for this device' };
    }

    const candidatePaths = new Set(readPlanPreviewCandidates(latest.plan).map((c) => c.path));
    const outside = target.paths.find((p) => !candidatePaths.has(p));
    if (outside) {
      return { ok: false, deny: `Path "${outside}" is not part of the latest cleanup preview` };
    }

    const estimatedBytes = readEstimatedBytes(latest.plan);
    if (estimatedBytes > ACT_DISK_CLEANUP_MAX_BYTES_V1) {
      return {
        ok: false,
        deny: `Cleanup plan (${estimatedBytes} bytes) exceeds the act-mode byte bound (${ACT_DISK_CLEANUP_MAX_BYTES_V1})`,
      };
    }

    return { ok: true, extra: {} };
  });
}

async function pinRunScript(
  op: ActOperation,
  target: Extract<ActTarget, { kind: 'script' }>,
  run: RevalidateActExecutionArgs['run'],
): Promise<PinStepResult> {
  return inSystemDbContext(async () => {
    // Rebuild the minimal arguments the resolver needs — NOT the model's
    // original `input` verbatim, so a `parameters` payload the resolver
    // doesn't pin can't smuggle anything into what gets hashed. `deviceIds`
    // is always exactly `[run.deviceId]` here — `op.normalizeTarget` already
    // enforced that before this function is ever reached.
    const { digest, context } = await computeEffectDigestForRelease(
      op.toolName,
      { scriptId: target.scriptId, deviceIds: [run.deviceId] },
      db,
    );
    if (!digest || !context?.verifiedRunScript) {
      // "unpinned script → deny" (Task 3 contract) — a script that cannot be
      // read/pinned right now must never be run unattended, and there is no
      // safer content to fall back to.
      return { ok: false, deny: 'run_script content could not be pinned (missing, deleted, or unreadable)' };
    }
    return { ok: true, extra: { toolExecutionContext: context } };
  });
}

async function pinPlaybook(
  target: Extract<ActTarget, { kind: 'playbook' }>,
): Promise<PinStepResult> {
  return inSystemDbContext(async () => {
    const [row] = await db
      .select({
        isBuiltIn: playbookDefinitions.isBuiltIn,
        isActive: playbookDefinitions.isActive,
        orgId: playbookDefinitions.orgId,
        steps: playbookDefinitions.steps,
      })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, target.playbookId))
      .limit(1);

    // A missing row, a custom (org-authored) playbook, or one an operator
    // deactivated all land the same way: NOT an execution the built-in-only
    // manifest covers, but still a legitimate call the agent made — record
    // it as a proposal exactly like an unmatched Tier-3 mutation would,
    // rather than a hard deny. This is what keeps custom playbooks
    // proposal-only under act mode (Task 5's contract) without the pure,
    // I/O-less `resolveActOperation` needing to know built-in-ness.
    if (!row || !row.isBuiltIn || row.orgId !== null || !row.isActive) {
      return { ok: false, downgrade: 'propose' };
    }

    const playbookDigest = createHash('sha256').update(JSON.stringify(row.steps)).digest('hex');
    return { ok: true, extra: { playbookDigest } };
  });
}

async function pinAsset(
  op: ActOperation,
  target: ActTarget,
  run: RevalidateActExecutionArgs['run'],
): Promise<PinStepResult> {
  switch (target.kind) {
    case 'service':
      // No extra I/O pin: `normalizeTarget` already extracted the service
      // name from the model's own input — there is nothing further to read
      // before dispatch.
      return { ok: true, extra: {} };
    case 'process':
      // Unreachable through the real pipeline as of #3826 (scoped re-review):
      // `manage_processes.kill` was removed from `ACT_MANIFEST`, so no
      // `resolveActOperation` match ever produces a 'process' target anymore.
      // Kept only so this switch stays exhaustive over `ActTarget`. Note for
      // whenever the op is re-admitted: unlike `pinDiskCleanup` below, this
      // branch does NOT re-read live state — `normalizeTarget` only checks
      // that `pid`/`processName` are present in the model's own input, it
      // never re-queries the live process list to confirm the pid still
      // names that process. A real pid→name identity pin (an
      // `executeCommand list_processes` read + name match immediately before
      // dispatch, mirroring `pinDiskCleanup`'s preview-plan re-read) is a
      // prerequisite for re-admitting the op, not something this branch
      // already provides.
      return { ok: true, extra: {} };
    case 'disk_cleanup':
      return pinDiskCleanup(target, run);
    case 'script':
      return pinRunScript(op, target, run);
    case 'playbook':
      return pinPlaybook(target);
    case 'suggestion':
      // Virtual — `remediation_suggestion` never reaches this function
      // through the real pipeline (actManifest.ts); the Task 7 resolver
      // resolves straight to the `run_script` op instead of calling here
      // with a 'suggestion' target.
      return { ok: false, deny: 'remediation_suggestion has no direct revalidation path' };
    default: {
      const exhaustive: never = target;
      return { ok: false, deny: `Unknown act target kind: ${JSON.stringify(exhaustive)}` };
    }
  }
}

type ExposureReservationResult = { ok: true } | { ok: false; reason: 'fleet_cap_exceeded' };

/**
 * Wave 5 Part B (#3827) — unattended-exposure ledger accounting for the act
 * lane. Writes ONE `ai_unattended_exposure` row (`source: 'act'`, `intentId:
 * null`) per act-mode call that actually reserves a slot, and — ONLY while
 * `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is on — enforces the SAME
 * org-wide fleet-percent cap `policyDecide.ts`'s `runAuthorizeTransaction`
 * enforces for the policy-decide lane (advisory-lock + floor, duplicated
 * locally here rather than imported — this directory's established leaf-
 * module convention; see `inSystemDbContext`'s own header comment). The two
 * lanes share ONE ledger table and must agree on how the fleet-wide
 * numerator (distinct devices exposed org-wide, trailing 24h, act + policy
 * combined) is computed.
 *
 * Flag-independence (plan Task 4): the WRITE is unconditional — an act-mode
 * execution accounts for itself in the ledger whether or not the
 * policy-decide flag is on, so the ledger's own 24h trailing window already
 * has real history the moment an operator flips the flag on, rather than
 * starting from zero. Only the CAP ENFORCEMENT is flag-gated, which is what
 * keeps wave-4 act-mode behavior byte-identical (bounded solely by
 * `maxActionsPerRun`) until wave 5 turns the sub-flag on.
 *
 * Called from Step 5 AFTER the `maxActionsPerRun` in-memory check already
 * passed, so an already-exhausted run never reaches this DB-backed check —
 * and, symmetrically, a call that fails the fleet cap here never reaches
 * (never increments) the `maxActionsPerRun` counter either.
 */
async function reserveActUnattendedExposure(args: {
  run: RevalidateActExecutionArgs['run'];
  maxFleetPercentPerDay: number;
}): Promise<ExposureReservationResult> {
  const { run, maxFleetPercentPerDay } = args;
  const enforceCap = policyDecideEnabled();

  return inSystemDbContext(async (): Promise<ExposureReservationResult> => {
    if (enforceCap) {
      // Per-org advisory lock — same key shape as policyDecide.ts's
      // `runAuthorizeTransaction`, serializing concurrent act+policy
      // reservations for the SAME org so the check below can't overshoot by
      // more than one device per race. Released automatically on
      // commit/rollback of this call's own transaction (withSystemDbAccessContext
      // opens one) — no separate unlock call.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-exposure:${run.orgId}`}, 0))`);

      const windowStart = sql`now() - interval '24 hours'`;
      const exposedDeviceRows = await db
        .select({ deviceId: aiUnattendedExposure.deviceId })
        .from(aiUnattendedExposure)
        .where(and(eq(aiUnattendedExposure.orgId, run.orgId), gt(aiUnattendedExposure.reservedAt, windowStart)));
      const exposedDevices = new Set(exposedDeviceRows.map((r) => r.deviceId));
      const deviceAlreadyExposed = exposedDevices.has(run.deviceId);

      const contractDeviceCount = await countContractDevices(run.orgId, null);
      // floor(), no max(1, ·) — same locked quorum decision policyDecide.ts
      // enforces: a tiny fleet with a sub-1-device allowance gets ZERO
      // unattended executions, act or policy.
      const allowance = Math.floor((contractDeviceCount * maxFleetPercentPerDay) / 100);
      const projectedDistinctDevices = exposedDevices.size + (deviceAlreadyExposed ? 0 : 1);
      if (projectedDistinctDevices > allowance) {
        return { ok: false, reason: 'fleet_cap_exceeded' };
      }
    }

    // The org's OWNING partner — needed for the exposure row's composite
    // (org_id, partner_id) FK, independent of whether this particular agent
    // is org- or partner-owned (mirrors policyDecide.ts's own lookup).
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, run.orgId))
      .limit(1);
    if (!org) {
      // Structurally unreachable: the run's own org row must exist for the
      // run to have been admitted at all.
      throw new Error(`reserveActUnattendedExposure: org ${run.orgId} not found`);
    }

    await db.insert(aiUnattendedExposure).values({
      orgId: run.orgId,
      partnerId: org.partnerId,
      agentId: run.agentId,
      runId: run.id,
      deviceId: run.deviceId,
      intentId: null,
      source: 'act',
    });

    return { ok: true };
  });
}

/**
 * Revalidate a manifest-matched act-mode call immediately before dispatch,
 * and reserve a `maxActionsPerRun` slot for it. See the module header for the
 * deny-vs-downgrade contract this enforces.
 */
export async function revalidateActExecution(
  args: RevalidateActExecutionArgs,
): Promise<ActRevalidationResult> {
  const { run, op, toolName, input, reserved } = args;

  // Step 1: live policy re-resolve — same identity + enabled + mode checks
  // `isStoppedBeforeStart` (runLoop.ts) applies at admission, re-run here
  // because minutes can pass between a tool call being queued and dispatched.
  let current;
  try {
    current = await resolveEffectiveAgentSystem(run.orgId, run.agentKind);
  } catch (error) {
    console.error('[actRevalidation] failed to re-resolve the live agent policy', {
      runId: run.id, toolName, error,
    });
    return { ok: false, deny: 'Could not re-resolve the live agent policy' };
  }
  if (!current) {
    return { ok: false, deny: 'No effective agent policy is configured for this org' };
  }
  if (current.agentId !== run.agentId) {
    // Same identity guard as `isStoppedBeforeStart` — a same-kind replacement
    // agent must never inherit this run's unattended authority.
    return { ok: false, deny: "The run's agent is no longer the effective agent for this org" };
  }
  if (!current.effective.enabled) return { ok: false, deny: 'Agent is disabled' };
  if (current.effective.mode === 'off') return { ok: false, deny: 'Agent mode is off' };
  if (current.effective.mode === 'shadow') {
    // Drift act → shadow converts to a proposal — an operator narrowing act
    // to shadow mid-run still wants the agent's intended action recorded.
    return { ok: false, downgrade: 'propose' };
  }

  // Step 2: full guardrail re-run against the LIVE policy slice (not the
  // run's start-of-run snapshot). `checkAgentGuardrails` reads the DB
  // kill-state gate synchronously off a module-level cache (Wave 5A Task 2,
  // #3827) — refresh it here, immediately before the re-run, so a kill
  // engaged since run admission is visible to THIS dispatch rather than only
  // to the next run's `isStoppedBeforeStart` check.
  await readAiKillState();
  const livePolicy: AgentGuardrailPolicy = {
    enabled: current.effective.enabled,
    mode: current.effective.mode,
    toolAllowlist: current.effective.toolAllowlist,
    protectedResources: current.effective.protectedResources,
    deviceId: run.deviceId,
    deviceSiteId: run.deviceSiteId,
  };
  const liveCheck = checkAgentGuardrails(toolName, input, livePolicy);
  if (liveCheck.disposition === 'propose') return { ok: false, downgrade: 'propose' };
  if (liveCheck.disposition !== 'act') {
    // 'deny' (allowlist narrowed, resource now protected, site drift, …) or
    // any other outcome — every one of these is a genuine safety change,
    // never a soft downgrade.
    return { ok: false, deny: liveCheck.reason ?? `Live guardrail re-check refused "${toolName}"` };
  }

  // Step 3: normalize the target against the run's OWN device — never trust
  // the model's device argument twice.
  const normalized = op.normalizeTarget(input, run.deviceId);
  if (!normalized.ok) {
    // Review fix (#3826 final-review): a device-arg mismatch is a genuine
    // safety boundary and stays a hard deny, fail-closed. Anything else
    // (a missing/malformed identity field the manifest requires — e.g.
    // `manage_processes.kill` sent with no `processName`, which the tool's
    // own input_schema does not yet surface to the model on every call site)
    // is a malformed-but-legitimate call for an op the manifest DOES cover:
    // denying it outright would give act mode a NARROWER human-approval
    // surface than shadow mode has for that exact same call. Downgrade to a
    // proposal instead — the same "legitimate call, not currently
    // executable unattended" shape Step 3.5 and the playbook-pin step below
    // already use.
    if (normalized.deviceMismatch) {
      return { ok: false, deny: `Act revalidation: ${normalized.reason}` };
    }
    // #3826 cheap nonblocking fix: thread the concrete reason through so the
    // recorded proposal carries WHY it wasn't auto-executed, instead of a
    // bare downgrade a reviewer has to reverse-engineer.
    return { ok: false, downgrade: 'propose', reason: normalized.reason };
  }

  // Step 3.5 (Task 6, #3826): per-script act authorization. run_script's
  // manifest `matches` is shape-only (any scriptId matches — actManifest.ts
  // is pure and has no policy to consult), so THIS is where a saved script
  // actually gets authorized for unattended execution — `toolAllowlist`
  // admitting `run_script` only says the agent may call the tool at all.
  // Unauthorized is NOT a data problem (unlike an unreadable/deleted script,
  // which denies below in pinRunScript) — it is the same "legitimate call,
  // not currently act-eligible" shape as an unmatched Tier-3 mutation or a
  // custom (non-built-in) playbook, so it downgrades to a proposal, never a
  // deny: "run_script never act-eligible (proposals still work)" (Global
  // Constraints, plan header).
  if (normalized.target.kind === 'script') {
    const authorizedScriptIds = current.effective.actAssets.scriptIds;
    if (!authorizedScriptIds.includes(normalized.target.scriptId)) {
      return { ok: false, downgrade: 'propose' };
    }
  }

  // Step 4: op-specific asset pin, with I/O.
  const pinned = await pinAsset(op, normalized.target, run);
  if (!pinned.ok) return pinned;

  // Step 5: reserve a maxActionsPerRun slot against the LIVE cap — slotted
  // BEFORE dispatch, and never released: a failed/timeout/unknown dispatch
  // still consumed the slot (Global Constraints), only a read-only call
  // never reaches this function at all. The cheap in-memory check runs
  // first so an already-exhausted run never reaches the DB-backed exposure
  // accounting below.
  const cap = current.effective.limits.maxActionsPerRun;
  if (reserved.count >= cap) {
    // Exhausted. Mode is confirmed 'act' and the call mutates, so the
    // ordinary act-mode guardrail branch always admits a proposal for an
    // unmatched (or, here, un-reservable) mutation — there is no path here
    // where a proposal is unavailable.
    return { ok: false, downgrade: 'propose' };
  }

  // Step 5.5 (#3827 Task 4): unattended-exposure ledger accounting — writes
  // the shared `ai_unattended_exposure` row (unconditional) and, only while
  // the policy-decide sub-flag is on, enforces the org-wide fleet-percent
  // cap the policy-decide lane also reads. Exhaustion downgrades to a
  // proposal exactly like an exhausted maxActionsPerRun slot — mode is
  // confirmed 'act' and the call mutates, so a proposal is always available.
  //
  // The reserve call itself is wrapped: a DB error here (the `organizations`
  // lookup, the insert, pool exhaustion) must NOT propagate out of this
  // function — an uncaught throw is turned into a hard tool DENY by the
  // caller (aiAgentSdkTools.ts) that never lands in `outcome.deniedActions`,
  // and on the flag-OFF path (production today) this row is pure accounting
  // with zero enforcement value, so a transient failure must never convert a
  // previously-succeeding act execution into a denial — same best-effort
  // contract runLoop.ts's `recordAllowedExecution` uses for its own ledger
  // write. Flag ON is different: the fleet cap is a LIVE safety gate, so a
  // failed check must fail closed (degrade to a proposal, the same shape an
  // exhausted cap already uses) rather than silently grant capacity.
  let exposureReservation: ExposureReservationResult;
  try {
    exposureReservation = await reserveActUnattendedExposure({
      run,
      maxFleetPercentPerDay: current.effective.limits.maxFleetPercentPerDay,
    });
  } catch (error) {
    console.error('[actRevalidation] unattended-exposure reservation failed', {
      runId: run.id, toolName, error,
    });
    if (policyDecideEnabled()) return { ok: false, downgrade: 'propose' };
    exposureReservation = { ok: true };
  }
  if (!exposureReservation.ok) {
    return { ok: false, downgrade: 'propose' };
  }

  reserved.count += 1;

  return { ok: true, pin: { op, target: normalized.target, ...pinned.extra } };
}
