/**
 * Tool catalog W04 (#5219), plan Task A7 — execute ONE flow step (one for-each
 * item) for the runner (Task A8).
 *
 * The order is the plan's and it is load-bearing:
 *   1. `when` — false ⇒ skipped (nothing rendered, nothing read).
 *   2. render `input` against the run scope (`render_failed` on a template
 *      error or an oversized render).
 *   3. built-ins: `set` returns its values; `wait` returns `park_wait` — the
 *      runner writes the wait step COMPLETED with `{ waitUntil }` in the same
 *      checkpoint that parks the run, so a resume never re-enters it.
 *   4. `revalidateRenderedStep` — the rendered input UNMASKED against the live
 *      catalog, the publication's pin, and ownership of every referenced asset
 *      in the RUN org (a partner-wide flow included). Any failure is a policy
 *      failure: the run fails regardless of `onFailure`.
 *   5. tier 3: a pre-approved `run_script` (honoured on this run + a binding
 *      for this step) executes directly against ONE snapshot read that is both
 *      the binding comparison and the `verifiedRunScript` pin — content edited
 *      between check and pin can never run. Anything else parks on a
 *      `source: 'flow'` action intent; the existing inbox/release path owns it.
 *   6. tier 1/2: `executeTool` (core) or `executeTenantToolDetailed` (tenant,
 *      attributed to the RUN on the 'flow' surface).
 *
 * Every tool call runs inside `withFlowExecutionContext({ runId, chainDepth })`
 * (Decision 14) and is raced against the step deadline (Decision 15). A tool
 * call cannot be aborted, so on timeout this returns at once — tier 1 ⇒
 * `step_timeout`, tier ≥ 2 ⇒ `unknown_outcome` — and the late result is
 * dropped here; the runner's lease-fenced checkpoint guarantees it is never
 * written either. Only tier 1 retries (transient errors, 1 s / 4 s / 16 s).
 *
 * DB reads here (revalidation, the snapshot, intent creation) open their own
 * short system/caller contexts; no external I/O runs inside a transaction this
 * module opens.
 */
import {
  evaluateExpr,
  FLOW_BUILTIN_STEPS,
  FLOW_RUN_LIMITS,
  isFlowBuiltin,
  isTruthy,
  parseExpr,
  renderTemplates,
  type FlowDocumentV1,
  type FlowScope,
  type FlowStepErrorCode,
  type FlowValue,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { FlowRunRow, FlowVersionRow } from '../../db/schema/flowRuns';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { aiTools, executeTool, toolManagesDbContext } from '../aiTools';
import { createActionIntent } from '../actionIntents/intentService';
import { buildRunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import { flowPreApprovalBindingSchema, revalidateRenderedStep, type FlowStepPin } from '../flowValidator';
import type { VerifiedRunScript } from '../toolExecutionContext';
import { executeTenantToolDetailed } from '../toolSources/execute';
import { loadTenantToolForExecution, type ToolOwnerRef } from '../toolSources/resolver';
import { withFlowExecutionContext } from './flowExecutionContext';
import { FLOW_IGNORED_RUN_SCRIPT_KEYS, preApprovalMaterialFromSnapshot, type FlowPreApprovalBinding } from './preApproval';

/** Fields every non-skipped outcome may carry for the runner's step row. */
interface StepOutcomeMeta {
  /** The rendered input that was (or would have been) executed — what the step row records. */
  renderedInput?: Record<string, FlowValue>;
  /** Set when the step ran through its enable-time pre-approval (approval_mode 'pre_approved'). */
  approvalMode?: 'pre_approved';
}

export type StepOutcome =
  | ({ kind: 'completed'; output: FlowValue; truncated: boolean } & StepOutcomeMeta)
  | { kind: 'skipped' }
  /** policy=true ⇒ fail the run regardless of onFailure. */
  | ({ kind: 'failed'; code: FlowStepErrorCode; message: string; policy: boolean } & StepOutcomeMeta)
  /** The step may have executed; the run fails unknown_outcome regardless of onFailure. */
  | ({ kind: 'unknown_outcome'; message: string } & StepOutcomeMeta)
  | ({ kind: 'park_approval'; intentId: string } & StepOutcomeMeta)
  /** The wait step COMPLETES at park time with `output`. */
  | ({ kind: 'park_wait'; resumeAt: Date; output: { waitUntil: string } } & StepOutcomeMeta);

export interface StepExecutionInput {
  run: FlowRunRow;
  version: FlowVersionRow;
  step: FlowDocumentV1['steps'][number];
  pin: FlowStepPin;
  itemIndex: number | null;
  item: FlowValue | undefined;
  scope: FlowScope;
  /** The flow principal (`buildFlowAuthContext`) of this run. */
  auth: AuthContext;
  /** Absolute epoch ms; the step's `timeoutSec` from when the runner started it. */
  deadline: number;
  /** The `flow_run_steps` row the runner inserted (status 'running') for this attempt. */
  stepRowId: string;
}

/** Test seam: the backoff sleep (defaults to a real timer, so fake timers drive it too). */
export interface StepExecutorDeps {
  sleep?: (ms: number) => Promise<void>;
}

/** Tier-1 retry backoff (plan A7): three retries after the first attempt. */
export const FLOW_TIER1_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000];
/** What an oversized output keeps (`{ truncated: true, preview }`). */
export const FLOW_OUTPUT_PREVIEW_BYTES = 8_192;
const MAX_MESSAGE_CHARS = 1_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── transient classification (pinned by its own table test) ────────────────

const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);
const TRANSIENT_TEXT =
  /\b(?:HTTP|status(?:\s*code)?)[\s:]*(?:429|5\d\d)\b|\b(?:too many requests|rate[- ]limit(?:ed)?|service unavailable|bad gateway|gateway time-?out|socket hang up|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function httpStatusOf(value: unknown): number | null {
  if (!isRecord(value) && !(value instanceof Error)) return null;
  const v = value as unknown as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    if (typeof v[key] === 'number' && Number.isInteger(v[key])) return v[key] as number;
  }
  return null;
}

const isTransientStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/**
 * Whether a tool failure is worth retrying (tier 1 only): network errors, HTTP
 * 5xx and 429. Takes a thrown error or a parsed tool result (`{ error, status? }`).
 * No result classifier exists on main; this is deliberately local and
 * conservative — anything it cannot recognise is NOT transient.
 */
export function isTransientFlowToolError(value: unknown): boolean {
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;
    const status = httpStatusOf(value);
    if (status !== null) return isTransientStatus(status);
    return TRANSIENT_TEXT.test(value.message);
  }
  if (typeof value === 'string') return TRANSIENT_TEXT.test(value);
  if (!isRecord(value) || !('error' in value)) return false;
  const status = httpStatusOf(value) ?? httpStatusOf(value.error);
  if (status !== null) return isTransientStatus(status);
  const err = value.error;
  if (typeof err === 'string') return TRANSIENT_TEXT.test(err);
  if (isRecord(err) && typeof err.message === 'string') return TRANSIENT_TEXT.test(err.message);
  return false;
}

// ── small helpers ───────────────────────────────────────────────────────────

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return clip(value.message || value.name);
  if (typeof value === 'string') return clip(value);
  if (isRecord(value)) {
    const err = value.error;
    if (typeof err === 'string') return clip(err);
    if (isRecord(err) && typeof err.message === 'string') return clip(err.message);
  }
  try {
    return clip(JSON.stringify(value) ?? 'Tool call failed.');
  } catch {
    return 'Tool call failed.';
  }
}

/** The step's output as stored: oversized ⇒ `{ truncated: true, preview: <first 8 KB of its JSON> }`. */
function storedOutput(value: FlowValue): { output: FlowValue; truncated: boolean } {
  const serialized = JSON.stringify(value) ?? 'null';
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length <= FLOW_RUN_LIMITS.maxStoredOutputBytes) return { output: value, truncated: false };
  // Cut on bytes, then drop a trailing partial UTF-8 sequence's replacement char.
  const preview = bytes.subarray(0, FLOW_OUTPUT_PREVIEW_BYTES).toString('utf8').replace(/�+$/, '');
  return { output: { truncated: true, preview }, truncated: true };
}

/** A tool's string result as a FlowValue: JSON when it parses, else `{ text }`. */
function parseToolText(text: string): FlowValue {
  try {
    return JSON.parse(text) as FlowValue;
  } catch {
    return { text };
  }
}

/** A parsed core-tool result that reports failure. */
function isErrorResult(tool: string, value: FlowValue): boolean {
  if (!isRecord(value)) return false;
  if ('error' in value && value.error !== null && value.error !== undefined && value.error !== false) return true;
  // run_script answers per device; a call where EVERY targeted device was
  // refused or failed to dispatch did nothing, and an unattended flow must not
  // record that as a completed step.
  if (tool === 'run_script' && isRecord(value.results)) {
    const perDevice = Object.values(value.results);
    return perDevice.length > 0 && perDevice.every((r) => isRecord(r) && typeof r.error === 'string');
  }
  return false;
}

/**
 * The flow's tool owner. Org flow ⇒ the run org's partner (the flow principal
 * carries it); partner-wide flow ⇒ its partner, which must be the run org's.
 */
function ownerOf(version: FlowVersionRow, run: FlowRunRow, auth: AuthContext): ToolOwnerRef | null {
  if (!auth.partnerId) return null;
  if (version.orgId) return version.orgId === run.orgId ? { orgId: version.orgId, partnerId: auth.partnerId } : null;
  return version.partnerId && version.partnerId === auth.partnerId ? { orgId: null, partnerId: version.partnerId } : null;
}

type BindingLookup = { kind: 'none' } | { kind: 'bound'; binding: FlowPreApprovalBinding } | { kind: 'invalid' };

/** The publication's pre-approval for this step, parsed (jsonb decides unattended Tier-3 work). */
function bindingFor(version: FlowVersionRow, stepId: string): BindingLookup {
  const entries = Array.isArray(version.preApprovals) ? version.preApprovals : [];
  const mine = entries.filter((e) => isRecord(e) && e.stepId === stepId);
  if (mine.length === 0) return { kind: 'none' };
  if (mine.length > 1) return { kind: 'invalid' };
  const parsed = flowPreApprovalBindingSchema.safeParse(mine[0]);
  return parsed.success ? { kind: 'bound', binding: parsed.data } : { kind: 'invalid' };
}

function flowNameOf(version: FlowVersionRow): string {
  const name = isRecord(version.definition) ? version.definition.name : undefined;
  return typeof name === 'string' && name.length > 0 ? name : 'Flow';
}

// ── deadline + retry ─────────────────────────────────────────────────────────

type Settled<T> = { kind: 'value'; value: T } | { kind: 'threw'; error: unknown } | { kind: 'timeout' };

/**
 * Race `start()` against the absolute `deadline`. The started promise is never
 * cancelled (nothing can cancel `executeTool`); once the deadline wins, its
 * eventual value or rejection is swallowed and never returned.
 */
function raceDeadline<T>(start: () => Promise<T>, deadline: number): Promise<Settled<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ kind: 'timeout' });
  return new Promise<Settled<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
    let started: Promise<T>;
    try {
      started = start();
    } catch (error) {
      clearTimeout(timer);
      resolve({ kind: 'threw', error });
      return;
    }
    started.then(
      (value) => { clearTimeout(timer); resolve({ kind: 'value', value }); },
      (error: unknown) => { clearTimeout(timer); resolve({ kind: 'threw', error }); },
    );
  });
}

/** One attempt's normalized result. */
type CallResult = { ok: true; value: FlowValue } | { ok: false; failure: unknown };

interface ToolCallPlan {
  tier: 1 | 2 | 3;
  call: () => Promise<CallResult>;
  meta: StepOutcomeMeta;
}

async function runToolCall(i: StepExecutionInput, plan: ToolCallPlan, sleep: (ms: number) => Promise<void>): Promise<StepOutcome> {
  const { tier, call, meta } = plan;
  const frame = { runId: i.run.id, chainDepth: i.run.chainDepth };
  const maxRetries = tier === 1 ? FLOW_TIER1_RETRY_DELAYS_MS.length : 0;
  const timedOut = (attempted: boolean): StepOutcome => (tier === 1 || !attempted
    ? { kind: 'failed', code: 'step_timeout', message: 'The step did not finish before its timeout.', policy: false, ...meta }
    : { kind: 'unknown_outcome', message: 'The step did not finish before its timeout; it may have taken effect.', ...meta });

  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= i.deadline) return timedOut(attempt > 0);
    const settled = await raceDeadline(() => withFlowExecutionContext(frame, call), i.deadline);
    if (settled.kind === 'timeout') return timedOut(true);

    let failure: unknown;
    if (settled.kind === 'threw') {
      // A throw from tier ≥ 2 may have come after the effect was dispatched.
      if (tier !== 1) {
        return { kind: 'unknown_outcome', message: `The step failed unexpectedly and may have taken effect: ${messageOf(settled.error)}`, ...meta };
      }
      failure = settled.error;
    } else if (settled.value.ok) {
      return { kind: 'completed', ...storedOutput(settled.value.value), ...meta };
    } else {
      failure = settled.value.failure;
    }

    if (attempt < maxRetries && isTransientFlowToolError(failure)) {
      const delay = FLOW_TIER1_RETRY_DELAYS_MS[attempt]!;
      if (Date.now() + delay >= i.deadline) return timedOut(true);
      await sleep(delay);
      continue;
    }
    return { kind: 'failed', code: 'step_failed', message: messageOf(failure), policy: false, ...meta };
  }
}

// ── tier 3 ───────────────────────────────────────────────────────────────────

const failedPolicy = (code: FlowStepErrorCode, message: string, meta: StepOutcomeMeta): StepOutcome =>
  ({ kind: 'failed', code, message, policy: true, ...meta });

async function executePreApproved(
  i: StepExecutionInput,
  rendered: Record<string, FlowValue>,
  binding: FlowPreApprovalBinding,
  approvalScope: 'supervised' | 'four_eyes' | null,
  sleep: (ms: number) => Promise<void>,
): Promise<StepOutcome> {
  const meta: StepOutcomeMeta = { renderedInput: rendered, approvalMode: 'pre_approved' };
  if (i.pin.source !== 'core' || i.pin.tool !== 'run_script' || binding.stepId !== i.step.id || approvalScope !== 'supervised') {
    return failedPolicy('binding_drift', 'This step no longer matches its pre-approval.', meta);
  }
  if (Object.hasOwn(rendered, 'groupId')) {
    return failedPolicy('input_invalid', 'A pre-approved script step must target one device, not a group.', meta);
  }
  const deviceIds = rendered.deviceIds;
  if (!Array.isArray(deviceIds) || deviceIds.length !== 1 || typeof deviceIds[0] !== 'string') {
    return failedPolicy('input_invalid', 'A pre-approved script step must resolve to exactly one device.', meta);
  }
  const deviceId = deviceIds[0];
  if (rendered.scriptId !== binding.scriptId) {
    return failedPolicy('binding_drift', 'This step names a different script than the one pre-approved.', meta);
  }

  // ONE read. The binding comparison and the dispatch pin are both derived
  // from this snapshot, so content edited between "check" and "use" cannot
  // run: there is no second read to see it.
  const built = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () => buildRunScriptSnapshot({ scriptId: binding.scriptId, deviceIds: [deviceId] }, db),
      'flows.stepExecutor.preApprovedSnapshot',
    ),
  );
  if (built.kind !== 'snapshot') {
    return failedPolicy('binding_drift', 'The pre-approved script or its target device is no longer available.', meta);
  }
  // revalidateRenderedStep already placed the device in the run org; the
  // snapshot is the dispatch material, so it must agree.
  if (built.snapshot.deviceOrgIds.length !== 1 || built.snapshot.deviceOrgIds[0] !== i.run.orgId) {
    return failedPolicy('reference_not_owned', 'A script, device group or device this step names is not available to this flow run.', meta);
  }
  const material = preApprovalMaterialFromSnapshot(built.snapshot, rendered);
  if (material.variableDependent) {
    return failedPolicy('binding_drift', 'The pre-approved script now uses tenant variables; it must be approved again.', meta);
  }
  if (material.contentDigest !== binding.contentDigest) {
    return failedPolicy('binding_drift', 'The pre-approved script changed since the flow was enabled.', meta);
  }

  const verifiedRunScript: VerifiedRunScript = { snapshot: built.snapshot, scriptRow: built.scriptRow, scope: built.scope };
  return runToolCall(i, {
    tier: 3,
    meta,
    call: async () => {
      const text = await inToolDbContext('run_script', rendered, i.auth,
        () => executeTool('run_script', rendered, i.auth, { context: { verifiedRunScript } }));
      const value = parseToolText(text);
      return isErrorResult('run_script', value) ? { ok: false, failure: value } : { ok: true, value };
    },
  }, sleep);
}

async function parkForApproval(i: StepExecutionInput, rendered: Record<string, FlowValue>): Promise<StepOutcome> {
  const meta: StepOutcomeMeta = { renderedInput: rendered };
  let intent: Awaited<ReturnType<typeof createActionIntent>>;
  try {
    intent = await createActionIntent(i.auth, {
      source: 'flow',
      orgId: i.run.orgId,
      toolName: i.pin.tool,
      input: rendered,
      flowRun: {
        runId: i.run.id,
        stepRowId: i.stepRowId,
        delegatorUserId: i.version.enabledByUserId ?? null,
        triggeredByUserId: i.run.triggeredByUserId ?? null,
        flowName: flowNameOf(i.version),
        stepId: i.step.id,
      },
    });
  } catch (err) {
    // Nothing executed; an intent that cannot be minted is an authorization
    // or structural refusal, never something onFailure may skip past.
    return failedPolicy('step_failed', `The approval request could not be created: ${messageOf(err)}`, meta);
  }
  if (intent.status === 'cancelled') {
    // createActionIntent returns an intent already cancelled when nobody may
    // approve it (incl. the site-ceiling variant). The flow never self-approves.
    const noApprovers = typeof intent.errorCode === 'string' && intent.errorCode.startsWith('no_eligible_approvers');
    return failedPolicy(
      noApprovers ? 'no_eligible_approvers' : 'step_failed',
      noApprovers
        ? 'No one is eligible to approve this step.'
        : `The approval request was cancelled at creation (${intent.errorCode ?? 'unknown'}).`,
      meta,
    );
  }
  return { kind: 'park_approval', intentId: intent.id, ...meta };
}

// ── entry point ──────────────────────────────────────────────────────────────

export async function executeFlowStep(i: StepExecutionInput, deps: StepExecutorDeps = {}): Promise<StepOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const scope: FlowScope = i.itemIndex !== null ? { ...i.scope, item: i.item ?? null } : i.scope;

  // 1. when
  if (i.step.when !== undefined) {
    const parsed = parseExpr(i.step.when);
    if (!parsed.ok) return { kind: 'failed', code: 'render_failed', message: `when: ${parsed.error}`, policy: false };
    const evaluated = evaluateExpr(parsed.ast, scope);
    if (!evaluated.ok) return { kind: 'failed', code: 'render_failed', message: `when: ${evaluated.error}`, policy: false };
    if (!isTruthy(evaluated.value)) return { kind: 'skipped' };
  }

  // 2. render
  const r = renderTemplates(i.step.input, scope);
  if (!r.ok) {
    return { kind: 'failed', code: 'render_failed', message: r.pointer ? `${r.error} at ${r.pointer}` : r.error, policy: false };
  }
  if (!isRecord(r.value)) return { kind: 'failed', code: 'render_failed', message: 'Rendered input is not an object.', policy: false };
  let rendered = r.value as Record<string, FlowValue>;

  if (i.pin.stepId !== i.step.id || i.pin.tool !== i.step.tool) {
    return failedPolicy('drift', 'This step no longer matches what was published.', { renderedInput: rendered });
  }

  // 3. built-ins (in-process; never a tool call)
  if (i.pin.source === 'builtin') {
    if (!isFlowBuiltin(i.step.tool)) {
      return failedPolicy('tool_unavailable', `Built-in '${i.step.tool}' is not available.`, { renderedInput: rendered });
    }
    if (i.step.tool === 'set') {
      const parsed = FLOW_BUILTIN_STEPS.set.inputSchema.safeParse(rendered);
      if (!parsed.success) return failedPolicy('input_invalid', parsed.error.issues[0]?.message ?? 'Invalid set input.', { renderedInput: rendered });
      return { kind: 'completed', ...storedOutput(parsed.data.values as Record<string, FlowValue>), renderedInput: rendered };
    }
    const parsed = FLOW_BUILTIN_STEPS.wait.inputSchema.safeParse(rendered);
    if (!parsed.success) return failedPolicy('input_invalid', parsed.error.issues[0]?.message ?? 'Invalid wait input.', { renderedInput: rendered });
    const resumeAt = new Date(Date.now() + parsed.data.minutes * 60_000);
    return { kind: 'park_wait', resumeAt, output: { waitUntil: resumeAt.toISOString() }, renderedInput: rendered };
  }

  // 4. run-time revalidation, unmasked, against the RUN org
  const owner = ownerOf(i.version, i.run, i.auth);
  if (!owner) return failedPolicy('drift', 'This run no longer belongs to the flow\'s owner.', { renderedInput: rendered });
  const check = await revalidateRenderedStep(i.pin, rendered, { owner, runOrgId: i.run.orgId });
  if (!check.ok) return failedPolicy(check.code, check.message, { renderedInput: rendered });

  // A flow never dispatches a step's own run context for run_script (the
  // saved script's governs — see FLOW_IGNORED_RUN_SCRIPT_KEYS); drop it so the
  // approver, the pre-approval digest and the step record all see exactly what
  // will run.
  if (i.pin.source === 'core' && i.pin.tool === 'run_script') {
    rendered = Object.fromEntries(Object.entries(rendered).filter(([key]) => !FLOW_IGNORED_RUN_SCRIPT_KEYS.has(key)));
  }

  // 5. tier 3
  if (check.tier === 3) {
    const lookup = bindingFor(i.version, i.step.id);
    if (lookup.kind === 'invalid') {
      return failedPolicy('drift', 'This step\'s stored pre-approval is unreadable.', { renderedInput: rendered });
    }
    if (i.run.preApprovalsHonored && lookup.kind === 'bound') {
      return executePreApproved(i, rendered, lookup.binding, check.approvalScope, sleep);
    }
    return parkForApproval(i, rendered);
  }

  // 6. tier 1 / 2
  const meta: StepOutcomeMeta = { renderedInput: rendered };
  if (i.pin.source === 'tenant') {
    const loaded = await loadTenantToolForExecution(i.pin.tenantToolId, i.auth, i.run.orgId);
    if (!loaded) return failedPolicy('tool_unavailable', 'This step\'s tool is no longer available to the flow\'s owner.', meta);
    if (loaded.descriptor.id !== i.pin.tenantToolId || loaded.descriptor.revision !== i.pin.tenantRevision) {
      return failedPolicy('drift', 'This step\'s external tool changed since the flow was enabled.', meta);
    }
    const descriptor = loaded.descriptor;
    return runToolCall(i, {
      tier: check.tier,
      meta,
      call: async () => {
        // External I/O: never inside a transaction (spec §6.5). The executor
        // opens its own short system reads for the reload.
        const outcome = await runOutsideDbContext(() => executeTenantToolDetailed(descriptor, rendered, i.auth, {
          orgId: i.run.orgId,
          actor: { kind: 'flow', id: i.run.id },
          surface: 'flow',
        }));
        return outcome.isError ? { ok: false, failure: { error: outcome.text } } : { ok: true, value: parseToolText(outcome.text) };
      },
    }, sleep);
  }

  const tool = i.pin.tool;
  return runToolCall(i, {
    tier: check.tier,
    meta,
    call: async () => {
      const value = parseToolText(await inToolDbContext(tool, rendered, i.auth, () => executeTool(tool, rendered, i.auth)));
      return isErrorResult(tool, value) ? { ok: false, failure: value } : { ok: true, value };
    },
  }, sleep);
}

/**
 * The DB context a core tool call runs in — the same predicate the release
 * worker, the chat wrapper and the MCP route use (#7918): a self-managed tool
 * (run_script, …) opens its own short contexts and must not be wrapped (a held
 * transaction across its device wait gets killed by the idle-in-transaction
 * timeout); every other core tool runs in the flow principal's own org-scoped,
 * user-less context, never in whatever the runner happens to hold.
 */
function inToolDbContext<T>(tool: string, input: Record<string, unknown>, auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return toolManagesDbContext(aiTools.get(tool), input) ? runOutsideDbContext(fn) : withAuthDbAccessContext(auth, fn);
}
