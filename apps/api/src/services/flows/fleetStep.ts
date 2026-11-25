/**
 * Tool Catalog W06 (#5221) Task A6 — the runner's Tier-3 path for a
 * `run_script_on_targets` step (stepExecutor hands it over after run-time
 * revalidation). The selector is resolved ONCE here; then either:
 *
 *  - FLEET PRE-APPROVAL (rule 4, Decision 5): the step has a `fleet_v1`
 *    binding on this publication and the run honours pre-approvals (schedule,
 *    event and UI runs only — `honoursFleetPreApproval`). Before the first
 *    dispatch: every device of the set must be in the run org, the script is
 *    snapshotted for exactly that set, and the binding is revalidated against
 *    the live contract (script material, run context, parameters, offline
 *    policy, selector, dynamic group definitions, owner) and the resolved
 *    count against `maxTargets`. Any difference is `binding_drift` with
 *    nothing dispatched. Dispatch then runs from the SAME snapshot (no second
 *    read of the script).
 *  - APPROVAL: the step parks with its device list FROZEN — the intent's
 *    input is `{ scriptId, parameters, runAs, whenOffline, deviceIds }` with
 *    the resolved ids and no selector — so the approver sees the exact
 *    devices, the digest pins them, and the release dispatches exactly them.
 *    A `fleetFilter` step always takes this path (#12418 Decision 5).
 *
 * The run's provenance sets its ceiling (#12418 W02, Decision 3): an
 * AI-initiated run freezes at most RUN_SCRIPT_AI_MAX_DEVICES devices through
 * any selector; every other run keeps FLEET_MAX_TARGETS. It is applied while
 * the selection resolves, so it precedes both branches above.
 *
 * A selection with no device completes with `count: 0` (nothing to approve).
 */
import { FLEET_MAX_TARGETS, type FlowFleetStepOutput, type FlowValue } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { groupTargetIdsHash } from '../actionIntents/runScriptGroupTarget';
import { RUN_SCRIPT_AI_MAX_DEVICES } from '../actionIntents/runScriptLimits';
import { buildRunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import { resolveDeviceIdsInRunOrg } from './builtins/fleetTargets';
import { executeRunScriptOnTargets, fleetSelectorName, resolveFleetSelection, type FleetSelectorName, type RunScriptOnTargetsInput } from './builtins/runScriptOnTargets';
import type { BuiltinContext } from './builtins/types';
import {
  fleetScriptMaterialFromSnapshot,
  fleetSelectorGroupIds,
  honoursFleetPreApproval,
  revalidateFleetBinding,
} from './fleetPreApproval';
import type { FleetBindingV1 } from './fleetBindingSchema';
import { loadDynamicGroupDefinitions } from './fleetGroups';
import { recordFleetStepAiCeilingRefused } from './flowTriggerMetrics';
import type { FlowPreApprovalBinding } from './preApproval';
import type { StepExecutionInput, StepOutcome } from './stepExecutor';

/**
 * Started by an AI caller: chat or the ai_tool manual start, an MCP client, an
 * agent run. UI, API, schedule, event and webhook runs are not.
 */
export function isAiInitiatedRun(run: Pick<FlowRunRow, 'triggerKind' | 'triggeredVia'>): boolean {
  return run.triggerKind === 'tool' || run.triggeredVia === 'ai_tool';
}

/** The most devices a fleet step of this run may freeze. */
export function fleetActionCeiling(run: Pick<FlowRunRow, 'triggerKind' | 'triggeredVia'>): number {
  return isAiInitiatedRun(run) ? RUN_SCRIPT_AI_MAX_DEVICES : FLEET_MAX_TARGETS;
}

/** What a parked fleet step tells its approver. */
export interface FleetTargetSummary {
  count: number;
  /** `groupTargetIdsHash` of the frozen, sorted ids. */
  idsHash: string;
  selector: FleetSelectorName;
  /** At most FLEET_SAMPLE_SIZE, in hostname order. Device-reported text: render through `fleetTargetNote` only. */
  sampleHostnames: string[];
}

const FLEET_SAMPLE_SIZE = 5;
const SAMPLE_NAME_MAX_CHARS = 63;
const NOTE_MAX_CHARS = 600;

/**
 * A device-reported hostname as an approval card may show it: quoted, capped,
 * and cut to hostname characters. An allowlist, as in approvalPatchNames.ts:
 * no quote look-alike, control or format character, markup or space survives,
 * so a name can neither close its quotes nor read as a sentence. Null when
 * nothing is left.
 */
function sampleName(hostname: string): string | null {
  const clean = hostname
    .normalize('NFKC')
    .replace(/\p{M}/gu, '')
    .replace(/(?:[^\p{L}\p{N}._-]|\p{Lm})+/gu, '_')
    .replace(/^_+|_+$/g, '');
  if (!clean) return null;
  const chars = Array.from(clean);
  return `"${chars.length > SAMPLE_NAME_MAX_CHARS ? `${chars.slice(0, SAMPLE_NAME_MAX_CHARS - 1).join('')}…` : clean}"`;
}

/** The one sentence stored as the intent's `reason` and shown on the approval card. */
export function fleetTargetNote(s: FleetTargetSummary): string {
  const names = s.sampleHostnames.map(sampleName).filter((n): n is string => n !== null);
  const note = `Fleet step resolved ${s.count} device${s.count === 1 ? '' : 's'} via ${s.selector} (ids sha256 ${s.idsHash}); later membership changes do not change this run.${names.length ? ` Sample: ${names.join(', ')}.` : ''}`;
  return note.slice(0, NOTE_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, '');
}

async function summarize(i: StepExecutionInput, input: RunScriptOnTargetsInput, ctx: BuiltinContext, deviceIds: string[]): Promise<FleetTargetSummary> {
  const found = await resolveDeviceIdsInRunOrg({ orgId: i.run.orgId, partnerId: ctx.auth.partnerId! }, deviceIds);
  return {
    count: deviceIds.length,
    idsHash: groupTargetIdsHash(deviceIds),
    selector: fleetSelectorName(input),
    sampleHostnames: found.map((d) => d.hostname).sort().slice(0, FLEET_SAMPLE_SIZE),
  };
}

export interface FleetStepDeps {
  /** The step's stored binding on this publication; 'invalid' when unreadable. */
  binding: FlowPreApprovalBinding | null | 'invalid';
  /** Park for approval with this (frozen) input; the summary is what the approver is told about it. */
  park: (frozenInput: Record<string, FlowValue>, summary: FleetTargetSummary) => Promise<StepOutcome>;
  /** Run the dispatch inside the run's flow frame, raced against the step deadline. */
  run: (fn: () => Promise<StepOutcome>, meta: { renderedInput: Record<string, FlowValue>; approvalMode?: 'pre_approved' }) => Promise<StepOutcome>;
}

type Meta = { renderedInput: Record<string, FlowValue>; approvalMode?: 'pre_approved' };

function policy(code: 'drift' | 'binding_drift' | 'reference_not_owned', message: string, meta: Meta): StepOutcome {
  return { kind: 'failed', code, message, policy: true, ...meta };
}

function emptyOutput(warnings: string[]): FlowValue {
  const output: FlowFleetStepOutput = {
    dispatchedDeviceIds: [], succeededDeviceIds: [], failedDeviceIds: [], skippedOfflineDeviceIds: [], count: 0, succeededCount: 0, failedCount: 0, warnings,
  };
  return output as unknown as FlowValue;
}

function frozenInputOf(input: RunScriptOnTargetsInput, deviceIds: string[]): Record<string, FlowValue> {
  const out: Record<string, FlowValue> = { scriptId: input.scriptId };
  if (input.parameters !== undefined) out.parameters = input.parameters as FlowValue;
  if (input.runAs !== undefined) out.runAs = input.runAs;
  out.whenOffline = input.whenOffline;
  out.deviceIds = deviceIds;
  return out;
}

export async function executeFleetStep(
  i: StepExecutionInput,
  input: RunScriptOnTargetsInput,
  ctx: BuiltinContext,
  deps: FleetStepDeps,
): Promise<StepOutcome> {
  const rendered = input as unknown as Record<string, FlowValue>;
  const meta: Meta = { renderedInput: rendered };
  if (i.itemIndex !== null) {
    // Refused at save too; this guards a document that predates the rule. The
    // device claims would collide with the for-each unit rows (same ledger key).
    return { kind: 'failed', code: 'input_invalid', message: 'run_script_on_targets cannot run inside a for-each.', policy: true, ...meta };
  }
  if (deps.binding === 'invalid') return policy('drift', 'This step\'s stored pre-approval is unreadable.', meta);

  const selection = await resolveFleetSelection(input, ctx, undefined, { maxTargets: fleetActionCeiling(i.run) });
  if (selection.kind === 'outcome') {
    const o = selection.outcome;
    if (o.kind === 'failed' && o.code === 'targets_over_cap' && isAiInitiatedRun(i.run)) {
      recordFleetStepAiCeilingRefused({ selector: fleetSelectorName(input) });
    }
    return o.kind === 'skipped' ? o : { ...o, ...meta };
  }

  const bound = deps.binding;
  if (bound && bound.lane !== 'fleet') {
    // A fleet step can only carry a fleet binding; anything else is not what was enabled.
    return policy('binding_drift', 'This step no longer matches its pre-approval.', meta);
  }
  // No pre-approval lane for a fleetFilter: such a step parks whatever binding is stored.
  if (bound && !input.fleetFilter && honoursFleetPreApproval(i.run)) {
    return executePreApprovedFleet(i, input, selection, bound, ctx, deps);
  }

  if (selection.requested.length === 0) {
    return { kind: 'completed', output: emptyOutput(selection.warnings), truncated: false, ...meta };
  }
  return deps.park(frozenInputOf(input, selection.requested), await summarize(i, input, ctx, selection.requested));
}

async function executePreApprovedFleet(
  i: StepExecutionInput,
  input: RunScriptOnTargetsInput,
  selection: { requested: string[]; found: string[]; warnings: string[] },
  binding: FleetBindingV1,
  ctx: BuiltinContext,
  deps: FleetStepDeps,
): Promise<StepOutcome> {
  const meta: Meta = { renderedInput: input as unknown as Record<string, FlowValue>, approvalMode: 'pre_approved' };
  if (binding.stepId !== i.step.id || binding.publicationId !== i.version.id || i.pin.approvalScope !== 'supervised') {
    return policy('binding_drift', 'This step no longer matches its pre-approval.', meta);
  }
  if (selection.found.length !== selection.requested.length) {
    return policy('binding_drift', 'A device this step targets is not in the run\'s organization; the pre-approval does not cover it.', meta);
  }
  if (selection.found.length === 0) {
    return { kind: 'completed', output: emptyOutput(selection.warnings), truncated: false, ...meta };
  }

  // ONE read: the binding comparison and the dispatch both come from this snapshot.
  const built = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => buildRunScriptSnapshot({ scriptId: binding.scriptId, deviceIds: selection.found }, db),
    'flows.fleetStep.preApprovedSnapshot',
  ));
  if (built.kind !== 'snapshot') {
    return policy('binding_drift', 'The pre-approved script or its target devices are no longer available.', meta);
  }
  if (built.snapshot.deviceOrgIds.length !== 1 || built.snapshot.deviceOrgIds[0] !== i.run.orgId) {
    return policy('reference_not_owned', 'A script, device group or device this step names is not available to this flow run.', meta);
  }
  const groupDefinitions = await loadDynamicGroupDefinitions(i.run.orgId, fleetSelectorGroupIds(i.step.input));
  const check = revalidateFleetBinding(binding, {
    // The PUBLICATION's literal step, never the rendered input.
    material: fleetScriptMaterialFromSnapshot(built.snapshot, i.step.input),
    step: i.step,
    owner: ctx.owner,
    groupDefinitions,
    resolvedCount: selection.found.length,
  });
  if (!check.ok) return policy('binding_drift', `This step no longer matches its pre-approval (${check.detail}).`, meta);

  const out = await deps.run(
    () => executeRunScriptOnTargets(input, ctx, { script: built.scriptRow, deviceIds: selection.found, scope: built.scope }),
    meta,
  );
  return out.kind === 'skipped' ? out : { ...out, ...meta };
}
