/**
 * Action-plan state for the mobile chat (`action_plan` / `hybrid_plan`
 * approval modes).
 *
 * When the org's AI approval mode is plan-first, the model calls
 * `propose_action_plan` before a multi-step task. The server publishes
 * `plan_approval_required` and BLOCKS the tool on an in-memory resolver until
 * someone calls `POST /ai/sessions/:id/approve-plan` (10-minute timeout,
 * aiAgent.ts `waitForPlanApproval`). Plan approval is in-chat only: it creates
 * no `approval_requests` row and sends no push, so nothing in the approvals
 * takeover would ever surface it. Steps that match the approved plan then run
 * without per-step prompts; Tier-3 tools still go through the per-step
 * approval takeover regardless of mode.
 *
 * Pure logic only (no RN imports) so Vitest can cover it.
 */

export const PLAN_TOOL_NAME = 'propose_action_plan';
/** Server cap (aiAgentSdkTools.ts `propose_action_plan` schema: max 20 steps). */
const MAX_PLAN_STEPS = 20;

export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PlanStep {
  toolName: string;
  reasoning: string;
  status: PlanStepStatus;
}

/**
 * - `awaiting`: the server is blocked on a decision (or, replayed from
 *   history, no decision was ever recorded).
 * - `approved`: approved, seen from history (progress is not persisted).
 * - `executing` / `completed` / `aborted`: live progress after approval.
 * - `rejected`: the user said no, or the 10-minute wait ran out.
 * - `expired`: the server no longer has this plan pending.
 */
export type PlanStatus =
  | 'awaiting'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'aborted'
  | 'rejected'
  | 'expired';

export interface ChatPlan {
  /** The `propose_action_plan` tool call this plan came from, when known. */
  toolUseId: string | null;
  /** `ai_action_plans.id`; only known once `plan_approval_required` arrives. */
  planId: string | null;
  title: string | null;
  steps: PlanStep[];
  status: PlanStatus;
}

export type PlanStreamEvent =
  | { type: 'plan_approval_required'; planId: string; steps: unknown }
  | { type: 'plan_step_start'; planId: string; stepIndex: number; toolName?: string }
  | { type: 'plan_step_complete'; planId: string; stepIndex: number; toolName?: string; isError?: boolean }
  | { type: 'plan_complete'; planId: string; status: 'completed' | 'aborted' };

export type PlanDecision = 'approved' | 'rejected';

export function isPlanTool(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === PLAN_TOOL_NAME || name.endsWith(`__${PLAN_TOOL_NAME}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Steps off the wire (`plan_approval_required.steps` or the tool input). Only
 * the tool name and the model's reasoning are kept: the raw tool input stays
 * off the phone, as on the web card where it is hidden behind an expander.
 */
export function parsePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.toolName !== 'string' || !entry.toolName) continue;
    steps.push({
      toolName: entry.toolName,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : '',
      status: 'pending',
    });
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

/**
 * The plan as proposed by a `propose_action_plan` tool call. Live, the
 * `tool_use_start` event carries `input: {}`, so this is an empty stub that
 * `plan_approval_required` fills in; from history it is the full proposal.
 */
export function proposedPlan(toolUseId: string | null, input: unknown): ChatPlan {
  const record = isRecord(input) ? input : {};
  return {
    toolUseId,
    planId: null,
    title: typeof record.title === 'string' && record.title ? record.title : null,
    steps: parsePlanSteps(record.steps),
    status: 'awaiting',
  };
}

/**
 * Live `tool_use_input` for the plan tool call: `tool_use_start` carries
 * `input: {}` and `plan_approval_required` carries only the steps, so this is
 * the only live event that brings the plan title.
 */
export function applyPlanInput(plan: ChatPlan | undefined, toolUseId: string, input: unknown): ChatPlan | undefined {
  if (!plan || plan.toolUseId !== toolUseId) return plan;
  const title = isRecord(input) && typeof input.title === 'string' ? input.title : '';
  if (!title || plan.title === title) return plan;
  return { ...plan, title };
}

function bareToolName(name: string): string {
  return name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
}

/**
 * History replay: the saved rows carry no plan progress, but steps run in
 * order right after approval, so a later tool result matching the next
 * pending step means that step ran (failures are not persisted, so a tick
 * means "ran"). When every step has run the plan is `completed`; otherwise it
 * stays `approved`, because a stopped plan and an interrupted one look the same.
 */
export function applyHistoryStepResult(plan: ChatPlan, toolName: string): ChatPlan {
  if (plan.status !== 'approved') return plan;
  const next = plan.steps.findIndex((step) => step.status !== 'completed');
  if (next < 0 || bareToolName(plan.steps[next]!.toolName) !== bareToolName(toolName)) return plan;
  const steps = plan.steps.map((step, i) => (i === next ? { ...step, status: 'completed' as const } : step));
  return { ...plan, steps, status: steps.every((s) => s.status === 'completed') ? 'completed' : 'approved' };
}

/** Statuses a step event may move a plan out of. */
const RUNNABLE: ReadonlySet<PlanStatus> = new Set(['approved', 'executing']);

function withStep(plan: ChatPlan, index: number, status: PlanStepStatus): ChatPlan {
  if (index < 0 || index >= plan.steps.length) return { ...plan, status: 'executing' };
  return {
    ...plan,
    status: 'executing',
    steps: plan.steps.map((step, i) => (i === index ? { ...step, status } : step)),
  };
}

export function applyPlanEvent(plan: ChatPlan | undefined, event: PlanStreamEvent): ChatPlan | undefined {
  if (event.type === 'plan_approval_required') {
    const base = plan ?? proposedPlan(null, undefined);
    if (base.status !== 'awaiting') return base;
    const steps = parsePlanSteps(event.steps);
    return {
      ...base,
      planId: event.planId,
      steps: steps.length > 0 ? steps : base.steps,
    };
  }
  if (!plan || plan.planId !== event.planId) return plan;
  switch (event.type) {
    case 'plan_step_start':
      if (!RUNNABLE.has(plan.status)) return plan;
      return withStep(plan, event.stepIndex, 'running');
    case 'plan_step_complete':
      if (!RUNNABLE.has(plan.status)) return plan;
      return withStep(plan, event.stepIndex, event.isError ? 'failed' : 'completed');
    case 'plan_complete':
      return { ...plan, status: event.status === 'aborted' ? 'aborted' : 'completed' };
    default:
      return plan;
  }
}

/** The user's decision was accepted by the server. */
export function planDecided(plan: ChatPlan, decision: PlanDecision): ChatPlan {
  if (plan.status !== 'awaiting') return plan;
  return { ...plan, status: decision === 'approved' ? 'executing' : 'rejected' };
}

/** The server says the plan is no longer pending (timed out, aborted, decided elsewhere). */
export function planGone(plan: ChatPlan): ChatPlan {
  if (plan.status !== 'awaiting') return plan;
  return { ...plan, status: 'expired' };
}

function decisionOf(value: unknown): PlanDecision | null {
  if (typeof value === 'string') {
    try {
      return decisionOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (value.result === 'approved' || value.result === 'rejected') return value.result;
  return null;
}

/**
 * The decision recorded in the `propose_action_plan` tool result. The tool
 * returns `{ result: 'approved' | 'rejected', ... }`; because the tool is not
 * wrapped by the post-tool-use hook, its result may instead be recorded by
 * the dropped-call fallback as `{ error: '<that JSON text>' }`, so both shapes
 * are read.
 */
export function planDecisionFromToolOutput(output: unknown): PlanDecision | null {
  const direct = decisionOf(output);
  if (direct) return direct;
  if (isRecord(output) && typeof output.error === 'string') return decisionOf(output.error);
  return null;
}

/** Settle an awaiting plan from its tool result (history replay, or a late live result). */
export function applyPlanToolResult(plan: ChatPlan, output: unknown): ChatPlan {
  if (plan.status !== 'awaiting' && plan.status !== 'expired') return plan;
  const decision = planDecisionFromToolOutput(output);
  if (decision === 'approved') return { ...plan, status: 'approved' };
  if (decision === 'rejected') return { ...plan, status: 'rejected' };
  return { ...plan, status: 'expired' };
}

export type PlanCardAction = 'decide' | 'stop' | 'none';

/**
 * Which controls the plan card shows. `live` is whether the message is still
 * streaming: only then can the server be holding the plan open. A plan
 * replayed from an old conversation never offers buttons the server would
 * refuse.
 */
export function planCardAction(plan: ChatPlan, live: boolean): PlanCardAction {
  if (!live) return 'none';
  if (plan.status === 'awaiting') return plan.steps.length > 0 ? 'decide' : 'none';
  if (plan.status === 'executing') return 'stop';
  return 'none';
}

export function planStatusCaption(plan: ChatPlan, live: boolean): string {
  switch (plan.status) {
    case 'awaiting':
      if (!live) return 'No decision recorded';
      return plan.steps.length > 0 ? 'Waiting for your approval' : 'Preparing plan';
    case 'approved':
      return 'Approved';
    case 'executing':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'aborted':
      return 'Stopped';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'No longer waiting for approval';
  }
}

/**
 * How to treat a failed approve-plan / abort-plan call. 400 (nothing
 * pending), 404 (session no longer in memory) and 409 (decided or aborted
 * concurrently) all mean the plan is past deciding; anything else, including
 * a transport failure (status 0), may succeed on a retry.
 */
export function planDecisionFailure(status: number): 'gone' | 'retry' {
  return status === 400 || status === 404 || status === 409 ? 'gone' : 'retry';
}

export function formatPlanToolName(name: string): string {
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  const words = bare.replace(/_/g, ' ').trim();
  if (!words) return 'Step';
  return words.charAt(0).toUpperCase() + words.slice(1);
}
