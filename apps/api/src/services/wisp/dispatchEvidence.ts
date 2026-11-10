/**
 * #10427 (W08 Task 1) — dispatch evidence.
 *
 * Wisp once told a technician "the scan request went through" after a tool
 * that dispatched nothing. Two halves:
 *
 *  - `normaliseDispatchResult` runs in the in-process tool wrapper
 *    (aiAgentSdkTools.ts `makeHandler`, Wisp sessions only) before the result
 *    is compacted for the model. A dispatch-class tool that answers "success"
 *    with none of the ids its handler returns when it really dispatched is
 *    rewritten to `{ success: false, dispatchUnverified: true, note, result }`.
 *    The note says "unverified", not "nothing dispatched", so the model does
 *    not re-run the action; the handler's own payload stays under `result`.
 *  - `turnEvidenceFrom` summarises a Wisp turn's recorded tool outcomes
 *    (turnRecord.ts) into the `TurnEvidence` the promise linter checks.
 *
 * Narrow on purpose: a tool not in DISPATCH_EVIDENCE, an action outside an
 * entry's `actions`, non-JSON output, an error result, `success: false` and an
 * oversized-result capture envelope are never touched. Every entry's keys were
 * read from that handler's real success output; dispatchEvidence.test.ts pins
 * one recorded fixture per entry.
 *
 * Pure: imports only types, so the tool wrapper pays nothing to load it.
 */
import type { TurnEvidence } from './promiseLinter';
import type { WispTurnToolOutcome } from './turnRecord';

export type EvidenceRule = {
  /** JSON keys (at any depth) whose non-empty value proves the dispatch. */
  keys: readonly string[];
  /** When set, only these `input.action` values are dispatches (`list` never is). */
  actions?: readonly string[];
  /**
   * Tools that answer in prose carry their id in the text. Such output is
   * never rewritten (non-JSON is untouched); the pattern is read by
   * `turnEvidenceFrom` only.
   */
  text?: RegExp;
};

const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

/** The coordinator's admission (wisp/coordinator.ts RequestSpecialistResult, rendered by aiToolsWisp.ts). */
const SPECIALIST: EvidenceRule = { keys: ['admitted', 'runId', 'taskId', 'intentId', 'needsApproval', 'report'] };

export const DISPATCH_EVIDENCE: Readonly<Record<string, EvidenceRule>> = Object.freeze({
  // aiToolsFleet.ts: scan → queued[].commandId; install → jobId (the scheduled patch job).
  manage_patches: { keys: ['commandId', 'jobId'], actions: ['scan', 'install'] },
  // aiToolsScripts.ts: results[deviceId].commandId / executionId; a suppressed device has neither.
  run_script: { keys: ['commandId', 'executionId'] },
  // aiToolsScripts.ts → commandQueue.ts CommandResult.commandId (absent when no command row was written).
  execute_command: { keys: ['commandId'] },
  manage_services: { keys: ['commandId'], actions: ['start', 'stop', 'restart'] },
  // aiToolsAiAgentLaunch.ts: { queued: true, runId }.
  run_patch_plan: { keys: ['runId'] },
  launch_specialist: SPECIALIST,
  wisp_specialist_request: SPECIALIST,
  // wisp/checkInTools.ts: "Check-in scheduled (ID: <id>) …", or "check-in <id> fired/started now" for an event already met.
  schedule_check_in: { keys: [], text: new RegExp(String.raw`\bcheck-in (?:scheduled \(ID: )?${UUID}`, 'i') },
  // wisp/concernTools.ts
  create_watch: { keys: [], text: new RegExp(String.raw`^Watch created \(ID: ${UUID}\)`, 'i') },
  raise_concern: { keys: [], text: new RegExp(String.raw`^(?:Concern raised|Already on Wisp's radar) \(ID: ${UUID}\)`, 'i') },
  // wisp/memoryTools.ts
  remember: { keys: [], text: new RegExp(String.raw`^Remembered as unconfirmed \(ID: ${UUID}\)`, 'i') },
});

export const DISPATCH_UNVERIFIED_NOTE =
  'dispatch unverified: no job, command or intent id came back; do not report it as done and do not retry without checking';

export function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_-]+?__/i, '');
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function meaningful(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** True when any of `keys` holds a non-empty value anywhere in `value` (bounded depth). */
function hasEvidenceKey(value: unknown, keys: readonly string[], depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasEvidenceKey(v, keys, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k) && meaningful(v)) return true;
    if (hasEvidenceKey(v, keys, depth + 1)) return true;
  }
  return false;
}

/**
 * A recorded outcome is capped at WISP_TURN_TOOL_OUTPUT_MAX_CHARS, so a large
 * result may no longer parse; then look for a key with a non-empty value in the
 * raw text (also matches the escaped JSON inside a capture envelope).
 */
function rawHasEvidenceKey(text: string, keys: readonly string[]): boolean {
  return keys.some((k) => new RegExp(String.raw`\\?"${k}\\?"\s*:\s*(?!null\b|false\b|\\?""|\[\]|\{\})`).test(text));
}

function ruleApplies(rule: EvidenceRule, input: Record<string, unknown>): boolean {
  return !rule.actions || (typeof input.action === 'string' && rule.actions.includes(input.action));
}

export function normaliseDispatchResult(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): { output: string; unverified: boolean } {
  const untouched = { output, unverified: false };
  const rule = DISPATCH_EVIDENCE[bareToolName(toolName)];
  if (!rule || rule.keys.length === 0 || !ruleApplies(rule, input)) return untouched;
  const parsed = parseObject(output);
  if (!parsed) return untouched;
  if ('error' in parsed || parsed.success === false || 'artifact' in parsed) return untouched;
  if (hasEvidenceKey(parsed, rule.keys)) return untouched;
  return {
    output: JSON.stringify({ success: false, dispatchUnverified: true, note: DISPATCH_UNVERIFIED_NOTE, result: parsed }),
    unverified: true,
  };
}

/** Handoff statuses (packages/shared aiToolHandoff.ts) that mean an approval was granted and the work is in hand. */
const APPROVED_HANDOFF = new Set(['approved_executing', 'approved_completed']);
const APPROVAL_PENDING_RE = /\bapproval still pending\b/i;
const ASSESSMENT_ADMITTED = new Set(['queued', 'coalesced', 'upgraded']);
const LISTED_CHECK_IN_RE = new RegExp(String.raw`^\s*${UUID}\s*\|`, 'im');
const CONCERN_CHANGED_RE = new RegExp(String.raw`^Concern ${UUID} (?:resolved|snoozed)\b`, 'i');
const CONCERN_RAISED_RE = new RegExp(String.raw`^Concern raised \(ID: ${UUID}\)`, 'i');

function approvalCount(parsed: Record<string, unknown> | null, output: string): number {
  if (parsed) {
    if (typeof parsed.status === 'string' && APPROVED_HANDOFF.has(parsed.status)) return 1;
    if (parsed.needsApproval === true) return 1;
    if (typeof parsed.approvalWaitSeconds === 'number') return 1;
    if (typeof parsed.error === 'string' && APPROVAL_PENDING_RE.test(parsed.error)) return 1;
    return 0;
  }
  return APPROVAL_PENDING_RE.test(output) ? 1 : 0;
}

function assessmentAdmitted(parsed: Record<string, unknown> | null): boolean {
  const orgs = (parsed?.report as { orgs?: unknown } | undefined)?.orgs;
  return Array.isArray(orgs) && orgs.some((o) => ASSESSMENT_ADMITTED.has((o as { outcome?: unknown } | null)?.outcome as string));
}

export function turnEvidenceFrom(toolOutcomes: readonly WispTurnToolOutcome[]): TurnEvidence {
  const evidence: TurnEvidence = {
    checkInScheduled: false,
    watchCreated: false,
    specialistLaunched: false,
    dispatched: [],
    pendingApprovals: 0,
    assessmentQueued: false,
    concernChanged: false,
    toolCalls: 0,
    dispatchAttempted: false,
  };
  const dispatched = new Set<string>();
  for (const outcome of toolOutcomes) {
    evidence.toolCalls += 1;
    const name = bareToolName(outcome.toolName);
    const rule = DISPATCH_EVIDENCE[name];
    const attempted = rule !== undefined && ruleApplies(rule, outcome.input);
    if (attempted) evidence.dispatchAttempted = true;
    const parsed = parseObject(outcome.output);
    // Approvals first: "approval still pending" reaches the model as an error.
    evidence.pendingApprovals += approvalCount(parsed, outcome.output);
    if (outcome.isError) continue;
    if (parsed && 'error' in parsed && !('success' in parsed)) continue;

    if (name === 'list_check_ins' && LISTED_CHECK_IN_RE.test(outcome.output)) evidence.checkInScheduled = true;
    if ((name === 'resolve_concern' || name === 'snooze_concern') && CONCERN_CHANGED_RE.test(outcome.output)) {
      evidence.concernChanged = true;
    }

    if (!rule || !attempted) continue;
    const proven = rule.text
      ? rule.text.test(outcome.output)
      : parsed ? hasEvidenceKey(parsed, rule.keys) : rawHasEvidenceKey(outcome.output, rule.keys);
    if (!proven) continue;
    dispatched.add(name);
    if (name === 'schedule_check_in') evidence.checkInScheduled = true;
    if (name === 'create_watch') evidence.watchCreated = true;
    if (name === 'raise_concern' && CONCERN_RAISED_RE.test(outcome.output)) evidence.concernChanged = true;
    if (rule === SPECIALIST && parsed?.needsApproval !== true) {
      evidence.specialistLaunched = true;
      if (assessmentAdmitted(parsed)) evidence.assessmentQueued = true;
    }
  }
  evidence.dispatched = [...dispatched];
  return evidence;
}
