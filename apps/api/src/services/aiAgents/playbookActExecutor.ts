/**
 * Wave 4 Part B — the deterministic built-in playbook executor (Task 5, #3826).
 *
 * `execute_playbook`'s ordinary tool implementation (`aiToolsPlaybooks.ts`) is
 * a STUB: it creates the `playbook_executions` audit row and hands the model
 * back the resolved step list, expecting the MODEL to call each step's tool
 * itself, turn by turn. That is fine for shadow/propose (a human reviews
 * every mutation anyway) but is NOT a rule-equivalent shape for unattended
 * act-mode execution — nothing server-side enforces that the model actually
 * runs the steps in order, respects `verifyCondition`, or stops on failure.
 *
 * This module is the real executor for act mode: it owns the ENTIRE
 * diagnose → act → wait → verify loop for a BUILT-IN playbook, server-side,
 * with no model turn in between. Every individually mutating step is
 * re-admitted through the SAME `revalidateActExecution` + reservation gate an
 * ordinary top-level act op goes through (actRevalidation.ts) — a playbook is
 * not a bypass, it is N individually-gated mutations wrapped in sequencing.
 *
 * Wiring (runLoop.ts): the pre-tool-use hook still calls
 * `revalidateActExecution` for the `execute_playbook` call itself first —
 * that is what pins the built-in's content digest (`ActAssetPin.playbookDigest`,
 * actRevalidation.ts's `pinPlaybook`) and reserves ONE `maxActionsPerRun` slot
 * for "running this playbook" as a unit. Only once THAT succeeds does the
 * hook call `executeBuiltInPlaybookForRun` here instead of dispatching the
 * stub tool — see runLoop.ts's own comment at the call site for why the
 * ordinary `recordAllowedExecution` path is skipped entirely for this one op.
 *
 * Custom (org-authored) playbooks never reach this module: `pinPlaybook`
 * downgrades anything that isn't an active, org_id-null, is_built_in row to a
 * PROPOSAL before revalidation ever succeeds — this executor only ever sees a
 * `playbookId` that has already been proven built-in.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { desc } from 'drizzle-orm';
import type {
  ActExecutionVerdict,
  ActVerificationVerdict,
  AiAgentKind,
} from '@breeze/shared';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import {
  playbookDefinitions,
  playbookExecutions,
  type PlaybookStep,
  type PlaybookStepResult,
  type PlaybookStepResultStatus,
  type PlaybookVerificationCondition,
} from '../../db/schema/playbooks';
import { deviceDisks } from '../../db/schema/devices';
import { users } from '../../db/schema/users';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeTool } from '../aiTools';
import { resolveActOperation } from './actManifest';
import { revalidateActExecution, type ActReservationState } from './actRevalidation';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Review fix (#3826 final-review): every `deps.executeToolFn` dispatch below
 * MUST run with the agent's own tenant-scoped DB access context active, the
 * same as the ordinary SDK tool path (`aiAgentSdkTools.ts`'s `makeHandler`
 * re-enters `withDbAccessContext(dbAccessContextFromAuth(auth), ...)` around
 * every `executeTool` call). Without it, `getCurrentDb()` falls back to the
 * unscoped pool, `breeze_current_scope()` reads 'none', and every RLS-guarded
 * read (starting with `verifyDeviceAccess`) denies — the built-in Disk
 * Cleanup / Service Restart playbooks would die on their first diagnose step.
 *
 * `withAuthDbAccessContext` (middleware/auth.ts) is the canonical helper for
 * exactly this shape — "a background worker replaying a captured
 * AuthContext" — and it escapes any ambient context first
 * (`runOutsideDbContext`) before opening the fresh one, so it composes safely
 * whether called from inside `inSystemDbContext` (it never is, here) or from
 * no ambient context at all (the normal case, since the SDK's own
 * `makeHandler` already ran `runOutsideDbContext` before this executor was
 * ever reached).
 *
 * Wrapped PER CALL, not around the whole playbook loop: a `wait` step can
 * sleep up to 60s, and pinning a pooled connection idle-in-transaction across
 * that sleep is exactly the #1105 pool-poison class this repo has hit before.
 */
function withAgentToolDbContext<T>(agentAuth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return withAuthDbAccessContext(agentAuth, fn);
}

/** Lazy, cached import — same pattern as actVerify.ts's `getCommandQueue`.
 *  Kept lazy for consistency with that sibling module rather than any known
 *  circular-import requirement here. */
let _commandQueue: typeof import('../commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('../commandQueue');
  return _commandQueue;
}

/** The `revalidateActExecution`/`executeTool` shape this module depends on —
 *  overridable in tests so a unit test of the LOOP does not have to re-mock
 *  every dependency `revalidateActExecution` itself already has its own
 *  focused suite for (actRevalidation.test.ts). */
export interface PlaybookExecutorDeps {
  revalidate: typeof revalidateActExecution;
  executeToolFn: typeof executeTool;
  /** Direct `commandQueue.executeCommand` access for the `service_status`
   *  verify metric read — review fix (#3826 Task 5 follow-up): the
   *  `manage_services` TOOL only forwards `{ name: serviceName }` to the
   *  agent (aiToolsScripts.ts), but the agent's `ListServices` command reads
   *  `search`/`status`/`page`/`limit`, not `name` (agent/internal/remote/
   *  tools/services.go) — so going through the tool returns an UNFILTERED,
   *  50-row-paginated list on every real device, and the target service is
   *  usually not on page one. actVerify.ts's `verifyServiceRunning` already
   *  does this read correctly (`{ search: target.serviceName }` straight
   *  through `commandQueue.executeCommand`); this dep lets the playbook
   *  executor's read-back use the exact same call shape so the two act
   *  paths cannot drift on the same postcondition again. */
  executeCommandFn: typeof import('../commandQueue').executeCommand;
  sleepFn: (ms: number) => Promise<void>;
}

const REAL_DEPS: PlaybookExecutorDeps = {
  revalidate: revalidateActExecution,
  executeToolFn: executeTool,
  executeCommandFn: async (...args) => (await getCommandQueue()).executeCommand(...args),
  sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface PlaybookExecutorRun {
  id: string;
  orgId: string;
  agentId: string;
  agentKind: AiAgentKind;
  deviceId: string;
  deviceSiteId: string | null;
}

export interface PlaybookExecutorArgs {
  run: PlaybookExecutorRun;
  agentAuth: AuthContext;
  playbookId: string;
  /** `ActAssetPin.playbookDigest` computed by `pinPlaybook` at revalidation
   *  time (actRevalidation.ts) — the "match time" digest this executor
   *  re-hashes against at "execute time" per the Task 5 contract. */
  expectedDigest: string;
  variables: Record<string, unknown>;
  /** SAME counter object the top-level `execute_playbook` revalidation
   *  already reserved a slot against — every mutating step below reserves
   *  ADDITIONALLY against it, individually. */
  reserved: ActReservationState;
  /** Absolute epoch ms the run's wall-clock ceiling expires at — NOT a
   *  per-step timeout. Global Constraints: waitSeconds capped at 60/step,
   *  total wall-clock bounded by the run's remaining budget. */
  deadlineMs: number;
  deps?: Partial<PlaybookExecutorDeps>;
}

export interface PlaybookExecutorResult {
  execution: ActExecutionVerdict;
  verification: ActVerificationVerdict;
  /** Short, human-readable — never a raw tool input/output blob. */
  verifyDetail?: string;
  playbookExecutionId: string | null;
  playbookName: string;
  /** Success-shaped, model-facing text — see runLoop.ts's call site. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Digest pin + playbook_executions row
// ---------------------------------------------------------------------------

interface ReloadedPlaybook {
  id: string;
  name: string;
  steps: PlaybookStep[];
}

async function reloadAndVerifyDigest(
  playbookId: string,
  expectedDigest: string,
): Promise<{ ok: true; row: ReloadedPlaybook } | { ok: false; reason: string }> {
  return inSystemDbContext(async () => {
    const [row] = await db
      .select({
        id: playbookDefinitions.id,
        name: playbookDefinitions.name,
        steps: playbookDefinitions.steps,
        isBuiltIn: playbookDefinitions.isBuiltIn,
        isActive: playbookDefinitions.isActive,
        orgId: playbookDefinitions.orgId,
      })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, playbookId))
      .limit(1);

    // Re-check built-in-ness at EXECUTE time, not just at pin time — an
    // operator could deactivate or fork the definition in the (usually tiny,
    // but not zero, given waits up to 60s/step) gap between revalidation and
    // this executor actually starting.
    if (!row || !row.isBuiltIn || row.orgId !== null || !row.isActive) {
      return { ok: false, reason: 'playbook is no longer an active built-in definition' };
    }
    const digest = createHash('sha256').update(JSON.stringify(row.steps)).digest('hex');
    if (digest !== expectedDigest) {
      return { ok: false, reason: 'playbook definition changed since it was pinned for this execution' };
    }
    return { ok: true, row: { id: row.id, name: row.name, steps: row.steps } };
  });
}

async function resolveTriggeredByUserId(agentUserId: string): Promise<string | null> {
  // Same probe-degrade pattern as the stub tool (aiToolsPlaybooks.ts) and
  // commandQueue.ts:855-889 — an `ai_agent` principal's `auth.user.id` is the
  // agent's `ai_agents.id`, not a `users` row, so an unconditional insert
  // would die on the FK (23503).
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, agentUserId)).limit(1);
  return row ? agentUserId : null;
}

async function insertPlaybookExecutionRow(
  run: PlaybookExecutorRun,
  agentUserId: string,
  playbookRowId: string,
  variables: Record<string, unknown>,
): Promise<string | null> {
  return inSystemDbContext(async () => {
    try {
      const triggeredByUserId = await resolveTriggeredByUserId(agentUserId);
      const [execution] = await db
        .insert(playbookExecutions)
        .values({
          orgId: run.orgId,
          deviceId: run.deviceId,
          playbookId: playbookRowId,
          status: 'running',
          currentStepIndex: 0,
          steps: [],
          context: { variables },
          triggeredBy: 'ai',
          triggeredByUserId,
          startedAt: new Date(),
        })
        .returning({ id: playbookExecutions.id });
      return execution?.id ?? null;
    } catch (error) {
      // Best-effort, same philosophy as `startToolExecution` in runLoop.ts:
      // a ledger/audit write failing must never block a mutation that has
      // already been individually revalidated per-step below. The playbook
      // still runs for real; only the audit row is missing.
      console.error('[playbookActExecutor] failed to insert the playbook_executions row (non-fatal — execution proceeds)', {
        runId: run.id, playbookRowId, error,
      });
      return null;
    }
  });
}

async function finalizePlaybookExecutionRow(
  executionId: string | null,
  status: 'completed' | 'failed',
  steps: PlaybookStepResult[],
  errorMessage: string | undefined,
): Promise<void> {
  if (!executionId) return;
  await inSystemDbContext(async () => {
    try {
      await db
        .update(playbookExecutions)
        .set({
          status,
          currentStepIndex: steps.length,
          steps,
          errorMessage: errorMessage ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(playbookExecutions.id, executionId));
    } catch (error) {
      console.error('[playbookActExecutor] failed to finalize the playbook_executions row (non-fatal)', {
        executionId, status, error,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Variable substitution — type-preserving, unlike the stub tool's
// ---------------------------------------------------------------------------

/**
 * Substitutes `{{key}}` tokens against `variables`. Deliberately NOT the stub
 * tool's `JSON.stringify(steps).replace(/\{\{(\w+)\}\}/g, ...)` approach: that
 * stringifies EVERY variable through `String(v)` before substitution, so an
 * array variable (`cleanupPaths` — the Disk Cleanup built-in's `execute` step
 * declares `paths: '{{cleanupPaths}}'`) becomes a comma-joined STRING, which
 * `diskCleanupExecute.normalizeTarget` (actManifest.ts) then rejects outright
 * (`Array.isArray(rawPaths)` is false) — under the old substitution, the
 * shipped Disk Cleanup playbook could never actually execute unattended. A
 * bare `"{{key}}"` string (nothing else in the field) is replaced with the
 * RAW variable value, preserving its type; a token embedded in a larger
 * string still does plain string interpolation, matching the stub for that
 * case. A token with no matching variable is left untouched (same
 * "leave as-is" behavior as the stub) — normalizeTarget then rejects it,
 * which is the correct fail-closed outcome for a step that needed a variable
 * nobody supplied.
 */
function resolveVariable(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const bareMatch = /^\{\{(\w+)\}\}$/.exec(value);
    if (bareMatch) {
      const key = bareMatch[1]!;
      return key in variables ? variables[key] : value;
    }
    return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      key in variables ? String(variables[key]) : match);
  }
  if (Array.isArray(value)) return value.map((v) => resolveVariable(v, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveVariable(v, variables)]),
    );
  }
  return value;
}

/**
 * Review fix (#3826 Task 5 follow-up): `variables` is the model's raw
 * `execute_playbook` tool input (runLoop.ts passes `input.variables` through
 * verbatim) and every shipped built-in uses `{{deviceId}}` in every step, so
 * this is the ONLY thing standing between "single device, device-arg ===
 * run.deviceId" (a LOCKED quorum decision) and a model sending
 * `variables: { deviceId: <other-device> }` to redirect `diagnose`/allowlisted
 * steps — which dispatch straight through `executeToolFn` with no
 * revalidation — at a device the run was never pinned to. Two layers, not
 * one: (1) `deviceId` is spread LAST into `allVariables` so the model's
 * `variables.deviceId` can never win the token substitution, and (2) as a
 * belt-and-suspenders backstop against any future built-in that names
 * `deviceId` some other way (a literal, a differently-named token), every
 * resolved `toolInput` that ends up with a `deviceId` key has it forced back
 * to `run.deviceId` post-substitution, unconditionally.
 */
function resolvePlaybookSteps(
  steps: PlaybookStep[],
  variables: Record<string, unknown>,
  deviceId: string,
): PlaybookStep[] {
  const allVariables: Record<string, unknown> = { ...variables, deviceId };
  return steps.map((step) => {
    const resolvedInput = step.toolInput
      ? (resolveVariable(step.toolInput, allVariables) as Record<string, unknown>)
      : step.toolInput;
    if (resolvedInput && 'deviceId' in resolvedInput) {
      resolvedInput.deviceId = deviceId;
    }
    return { ...step, toolInput: resolvedInput };
  });
}

// ---------------------------------------------------------------------------
// Step execution helpers
// ---------------------------------------------------------------------------

function parseJsonObject(output: string | undefined): Record<string, unknown> | null {
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Both mutating built-in step tools (`disk_cleanup`, `manage_services`)
 * return a `CommandResult`-shaped JSON string (the same shape actVerify.ts's
 * `commandExecutionVerdict`/`diskCleanupVerdict` already parse for the
 * TOP-LEVEL act op) — duplicated locally rather than imported, matching the
 * convention every leaf module in this directory follows (see
 * actRevalidation.ts's header). `disk_cleanup` uses `executed`/`failed`;
 * `manage_services` uses `completed`/`timeout`/`failed`.
 */
function classifyMutatingStepExecution(toolName: string, output: string): ActExecutionVerdict {
  const parsed = parseJsonObject(output);
  const status = parsed && typeof parsed.status === 'string' ? parsed.status : undefined;
  if (toolName === 'disk_cleanup') {
    if (status === 'executed') return 'succeeded';
    if (status === 'failed') return 'failed';
    return 'unknown';
  }
  if (status === 'completed') return 'succeeded';
  if (status === 'timeout') return 'timeout';
  if (status === 'failed') return 'failed';
  return 'unknown';
}

/**
 * Deliberate, narrow deviation from the plan's literal "an act step whose
 * tool/action is NOT manifest-admitted aborts the playbook" wording. The
 * shipped Disk Cleanup built-in's own second step is `disk_cleanup` with
 * `action: 'preview'` (Tier-1/read-only — aiToolsFilesystem.ts) — genuinely
 * non-mutating, and it is what CREATES the `deviceFilesystemCleanupRuns`
 * preview-plan row the very next `execute` step needs
 * `pinDiskCleanup` (actRevalidation.ts) to find. Aborting on it, as the
 * literal wording would, makes the shipped Disk Cleanup playbook permanently
 * non-functional under act mode — clearly not the intent (Task 5's own
 * escape hatch: "never fake coverage" cuts the other way here — silently
 * failing the one built-in that most needs act mode would be the fake). This
 * allowlist is exactly this one audited pair, not "any read-shaped call":
 * anything else that is not a manifest match still aborts, fail-closed.
 */
function isKnownSafeNonMutatingActStep(tool: string, input: Record<string, unknown>): boolean {
  return tool === 'disk_cleanup' && input.action === 'preview';
}

interface MetricReadOk {
  ok: true;
  value: number | string;
}
interface MetricReadErr {
  ok: false;
  detail: string;
}
type MetricRead = MetricReadOk | MetricReadErr;

const SERVICE_STATUS_READ_TIMEOUT_MS = 30_000;

async function readServiceStatus(
  deps: PlaybookExecutorDeps,
  run: PlaybookExecutorRun,
  agentAuth: AuthContext,
  serviceName: string | undefined,
): Promise<MetricRead> {
  if (!serviceName) return { ok: false, detail: 'verify step has no serviceName to check against' };
  // Bypasses the `manage_services` TOOL deliberately — see the
  // `executeCommandFn` doc comment on `PlaybookExecutorDeps` for why going
  // through the tool cannot find the service on a real device.
  const result = await inSystemDbContext(() =>
    deps.executeCommandFn(run.deviceId, 'list_services', { search: serviceName }, {
      userId: agentAuth.user.id, timeoutMs: SERVICE_STATUS_READ_TIMEOUT_MS,
    }));
  if (result.status !== 'completed') {
    return { ok: false, detail: `service status read did not complete (${result.status})` };
  }
  const parsed = parseJsonObject(result.stdout ?? '{}');
  const services = Array.isArray(parsed?.services) ? (parsed!.services as unknown[]) : [];
  const match = services.find((s): s is { name: string; status: string } =>
    typeof s === 'object' && s !== null
    && typeof (s as { name?: unknown }).name === 'string'
    && (s as { name: string }).name.toLowerCase() === serviceName.toLowerCase());
  if (!match) return { ok: false, detail: 'service not found in read-back' };
  return { ok: true, value: match.status };
}

async function readDiskUsagePercent(deviceId: string): Promise<MetricRead> {
  return inSystemDbContext(async () => {
    const [row] = await db
      .select({ usedPercent: deviceDisks.usedPercent })
      .from(deviceDisks)
      .where(eq(deviceDisks.deviceId, deviceId))
      .orderBy(desc(deviceDisks.usedPercent))
      .limit(1);
    if (!row || typeof row.usedPercent !== 'number') {
      return { ok: false, detail: 'no disk usage reading available for this device' };
    }
    return { ok: true, value: row.usedPercent };
  });
}

async function readRamUsagePercent(
  deps: PlaybookExecutorDeps,
  run: PlaybookExecutorRun,
  agentAuth: AuthContext,
): Promise<MetricRead> {
  const output = await withAgentToolDbContext(agentAuth, () => deps.executeToolFn(
    'analyze_metrics', { deviceId: run.deviceId, metric: 'ram', hoursBack: 1 }, agentAuth,
  ));
  const parsed = parseJsonObject(output);
  const summary = parsed && typeof parsed.summary === 'object' && parsed.summary !== null
    ? (parsed.summary as Record<string, unknown>) : null;
  const ram = summary && typeof summary.ram === 'object' && summary.ram !== null
    ? (summary.ram as Record<string, unknown>) : null;
  const current = ram && typeof ram.current === 'number' ? ram.current : undefined;
  if (typeof current !== 'number') return { ok: false, detail: 'no ram metric available for this device' };
  return { ok: true, value: current };
}

interface StepCtx {
  run: PlaybookExecutorRun;
  agentAuth: AuthContext;
  deps: PlaybookExecutorDeps;
  reserved: ActReservationState;
  deadlineMs: number;
}

/** `implement exactly the metrics the built-ins use` (Task 5 contract) — the
 *  three shipped built-ins use exactly these three. Anything else is an
 *  "unknown metric" and reads back `inconclusive` rather than crashing. */
async function readMetric(
  metric: string | undefined,
  ctx: StepCtx,
  step: PlaybookStep,
): Promise<MetricRead> {
  if (metric === 'service_status') {
    const serviceName = typeof step.toolInput?.serviceName === 'string' ? step.toolInput.serviceName : undefined;
    return readServiceStatus(ctx.deps, ctx.run, ctx.agentAuth, serviceName);
  }
  if (metric === 'disk_usage_percent') return readDiskUsagePercent(ctx.run.deviceId);
  if (metric === 'ram_usage_percent') return readRamUsagePercent(ctx.deps, ctx.run, ctx.agentAuth);
  return { ok: false, detail: `unrecognized verify metric "${metric ?? ''}"` };
}

/** `null` means "not evaluable" (type mismatch or unknown operator) — a
 *  DIFFERENT outcome from a comparison that evaluates to `false`, and the
 *  caller scores it as `inconclusive` rather than `failed`. */
function evaluateCondition(actual: number | string, condition: PlaybookVerificationCondition): boolean | null {
  switch (condition.operator) {
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' ? actual < condition.value : null;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' ? actual > condition.value : null;
    case 'eq':
      if (typeof actual === 'string' && typeof condition.value === 'string') {
        return actual.toLowerCase() === condition.value.toLowerCase();
      }
      return actual === condition.value;
    case 'ne':
      if (typeof actual === 'string' && typeof condition.value === 'string') {
        return actual.toLowerCase() !== condition.value.toLowerCase();
      }
      return actual !== condition.value;
    case 'contains':
      return typeof actual === 'string' && typeof condition.value === 'string'
        ? actual.includes(condition.value) : null;
    default:
      return null;
  }
}

function stepResult(
  index: number,
  step: PlaybookStep,
  status: PlaybookStepResultStatus,
  toolOutput: string | undefined,
  startedAt: Date,
  error?: string,
): PlaybookStepResult {
  const completedAt = new Date();
  return {
    stepIndex: index,
    stepName: step.name,
    status,
    ...(step.tool ? { toolUsed: step.tool } : {}),
    ...(step.toolInput ? { toolInput: step.toolInput } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(error ? { error } : {}),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
}

interface RunStepsOutcome {
  status: 'completed' | 'failed';
  results: PlaybookStepResult[];
  execution: ActExecutionVerdict;
  verification: ActVerificationVerdict;
  detail?: string;
}

/**
 * The core sequential loop — see the module header for the per-type
 * contract. Exported for direct unit coverage without needing to go through
 * `executeBuiltInPlaybookForRun`'s DB read/write wrapper.
 */
export async function runPlaybookSteps(steps: PlaybookStep[], ctx: StepCtx): Promise<RunStepsOutcome> {
  const results: PlaybookStepResult[] = [];
  let sawVerifyFailed = false;
  let sawVerifyInconclusive = false;
  let sawVerifyPassed = false;
  let execution: ActExecutionVerdict = 'succeeded';
  let detail: string | undefined;
  let stop = false;

  for (let i = 0; i < steps.length && !stop; i++) {
    const step = steps[i]!;
    const startedAt = new Date();

    if (Date.now() >= ctx.deadlineMs) {
      results.push({
        stepIndex: i,
        stepName: step.name,
        status: 'skipped',
        error: 'run wall-clock budget exhausted before this step could start',
        startedAt: startedAt.toISOString(),
        completedAt: startedAt.toISOString(),
        durationMs: 0,
      });
      execution = 'timeout';
      detail = 'run wall-clock budget exhausted before the playbook finished';
      break;
    }

    try {
      if (step.type === 'diagnose') {
        const output = await withAgentToolDbContext(ctx.agentAuth, () =>
          ctx.deps.executeToolFn(step.tool ?? '', step.toolInput ?? {}, ctx.agentAuth));
        results.push(stepResult(i, step, 'completed', output, startedAt));
      } else if (step.type === 'act') {
        const stepInput = step.toolInput ?? {};
        const op = resolveActOperation(step.tool ?? '', stepInput);
        if (op) {
          // A genuinely mutating, manifest-admitted step: re-admitted
          // through the FULL revalidate+reserve gate, individually, exactly
          // like a top-level act op — see the module header.
          const revalidated = await ctx.deps.revalidate({
            run: ctx.run, op, toolName: step.tool!, input: stepInput, reserved: ctx.reserved,
          });
          if (!revalidated.ok) {
            // #3826 cheap nonblocking fix: prefer the actual downgrade
            // reason (threaded from `normalizeTarget`, e.g. a missing
            // identity field) over the canned drift/cap text, which is only
            // accurate for the drift/cap-exhaustion branches and was
            // previously shown even when a concrete reason existed.
            const reason = 'deny' in revalidated
              ? revalidated.deny
              : (revalidated.reason
                ?? 'the live policy no longer admits this mutating step unattended (drift or the action cap is exhausted)');
            results.push(stepResult(i, step, 'failed', undefined, startedAt, reason));
            execution = 'failed';
            detail = `step "${step.name}" could not be revalidated: ${reason}`;
            stop = true;
          } else {
            const output = await withAgentToolDbContext(ctx.agentAuth, () => ctx.deps.executeToolFn(
              step.tool!,
              stepInput,
              ctx.agentAuth,
              revalidated.pin.toolExecutionContext ? { context: revalidated.pin.toolExecutionContext } : undefined,
            ));
            const stepExec = classifyMutatingStepExecution(step.tool!, output);
            results.push(stepResult(i, step, stepExec === 'succeeded' ? 'completed' : 'failed', output, startedAt));
            if (stepExec !== 'succeeded') {
              execution = stepExec;
              detail = `mutating step "${step.name}" reported ${stepExec}`;
              stop = true;
            }
          }
        } else if (isKnownSafeNonMutatingActStep(step.tool ?? '', stepInput)) {
          const output = await withAgentToolDbContext(ctx.agentAuth, () =>
            ctx.deps.executeToolFn(step.tool ?? '', stepInput, ctx.agentAuth));
          results.push(stepResult(i, step, 'completed', output, startedAt));
        } else {
          const reason = `act step "${step.name}" (${step.tool ?? 'unknown tool'}) is not a manifest-admitted `
            + 'mutation or a recognized safe read';
          results.push(stepResult(i, step, 'failed', undefined, startedAt, reason));
          execution = 'failed';
          detail = reason;
          stop = true;
        }
      } else if (step.type === 'wait') {
        const requestedMs = Math.max(0, Math.min(step.waitSeconds ?? 0, 60)) * 1000;
        const remainingMs = Math.max(0, ctx.deadlineMs - Date.now());
        const sleepMs = Math.min(requestedMs, remainingMs);
        await ctx.deps.sleepFn(sleepMs);
        const completedAt = new Date();
        results.push({
          stepIndex: i,
          stepName: step.name,
          status: 'completed',
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs: completedAt.getTime() - startedAt.getTime(),
        });
      } else if (step.type === 'verify') {
        const metric = step.verifyCondition?.metric;
        const read = await readMetric(metric, ctx, step);
        if (!read.ok) {
          sawVerifyInconclusive = true;
          results.push(stepResult(i, step, 'failed', undefined, startedAt, read.detail));
          if ((step.onFailure ?? 'stop') !== 'continue') {
            detail = read.detail;
            stop = true;
          }
        } else {
          const passed = evaluateCondition(read.value, step.verifyCondition!);
          const readBack = JSON.stringify({ metric, value: read.value });
          if (passed === true) {
            sawVerifyPassed = true;
            results.push(stepResult(i, step, 'completed', readBack, startedAt));
          } else {
            const reason = passed === null
              ? `verify condition for metric "${metric}" is not evaluable against the read-back value`
              : `condition not met: ${metric} ${step.verifyCondition!.operator} `
                + `${JSON.stringify(step.verifyCondition!.value)} (got ${JSON.stringify(read.value)})`;
            if (passed === null) sawVerifyInconclusive = true; else sawVerifyFailed = true;
            results.push(stepResult(i, step, 'failed', readBack, startedAt, reason));
            if ((step.onFailure ?? 'stop') !== 'continue') {
              detail = reason;
              stop = true;
            }
          }
        }
      } else {
        // 'rollback' step TYPE, or `onFailure: 'rollback'` reached via one of
        // the branches above — Global Constraints / Task 5 contract: "no
        // rollback in wave 4". Treated as stop + note, never an attempt to
        // undo anything.
        const reason = 'rollback is not implemented in wave 4 act mode — treated as a stop';
        results.push(stepResult(i, step, 'skipped', undefined, startedAt, reason));
        execution = 'failed';
        detail = reason;
        stop = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(stepResult(i, step, 'failed', undefined, startedAt, message));
      execution = 'unknown';
      detail = `step "${step.name}" threw unexpectedly: ${message}`;
      stop = true;
    }
  }

  const verification: ActVerificationVerdict = sawVerifyFailed
    ? 'failed'
    : sawVerifyInconclusive
      ? 'inconclusive'
      : sawVerifyPassed
        ? 'passed'
        : 'skipped';

  return {
    status: execution === 'succeeded' ? 'completed' : 'failed',
    results,
    execution,
    verification,
    ...(detail ? { detail } : {}),
  };
}

function buildModelMessage(
  playbookName: string,
  execution: ActExecutionVerdict,
  verification: ActVerificationVerdict,
  detail: string | undefined,
): string {
  const outcomeText = execution !== 'succeeded'
    ? `did not complete cleanly (${execution})`
    : verification === 'passed'
      ? 'completed and its verification step passed'
      : verification === 'failed'
        ? 'completed but its verification step did not pass'
        : `completed (verification ${verification})`;
  return `Built-in playbook "${playbookName}" ${outcomeText}.`
    + (detail ? ` ${detail}.` : '')
    + ' This ran directly through the act-mode playbook executor — every mutating step was independently '
    + 'revalidated and reserved, and a human is notified of the result. Do not retry this call and do not '
    + 'perform these steps manually.';
}

/**
 * Execute a BUILT-IN playbook end-to-end, unattended, for one act-mode run.
 * See the module header for the full contract and the runLoop.ts wiring.
 */
export async function executeBuiltInPlaybookForRun(args: PlaybookExecutorArgs): Promise<PlaybookExecutorResult> {
  const { run, agentAuth, playbookId, expectedDigest, variables, reserved, deadlineMs } = args;
  const deps: PlaybookExecutorDeps = { ...REAL_DEPS, ...args.deps };

  const reloaded = await reloadAndVerifyDigest(playbookId, expectedDigest);
  if (!reloaded.ok) {
    return {
      execution: 'failed',
      verification: 'skipped',
      verifyDetail: reloaded.reason,
      playbookExecutionId: null,
      playbookName: '(unknown built-in playbook)',
      summary: `Built-in playbook execution was aborted before it started: ${reloaded.reason}. Do not retry.`,
    };
  }
  const { row } = reloaded;

  const executionId = await insertPlaybookExecutionRow(run, agentAuth.user.id, row.id, variables);
  const resolvedSteps = resolvePlaybookSteps(row.steps, variables, run.deviceId);
  const stepCtx: StepCtx = { run, agentAuth, deps, reserved, deadlineMs };

  const outcome = await runPlaybookSteps(resolvedSteps, stepCtx);

  await finalizePlaybookExecutionRow(
    executionId,
    outcome.status,
    outcome.results,
    outcome.status === 'failed' ? outcome.detail : undefined,
  );

  return {
    execution: outcome.execution,
    verification: outcome.verification,
    ...(outcome.detail ? { verifyDetail: outcome.detail } : {}),
    playbookExecutionId: executionId,
    playbookName: row.name,
    summary: buildModelMessage(row.name, outcome.execution, outcome.verification, outcome.detail),
  };
}
