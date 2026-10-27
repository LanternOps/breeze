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
 *
 * A selection with no device completes with `count: 0` (nothing to approve).
 */
import type { FlowFleetStepOutput, FlowValue } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildRunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import { executeRunScriptOnTargets, resolveFleetSelection, type RunScriptOnTargetsInput } from './builtins/runScriptOnTargets';
import type { BuiltinContext } from './builtins/types';
import {
  fleetScriptMaterialFromSnapshot,
  fleetSelectorGroupIds,
  honoursFleetPreApproval,
  revalidateFleetBinding,
} from './fleetPreApproval';
import type { FleetBindingV1 } from './fleetBindingSchema';
import { loadDynamicGroupDefinitions } from './fleetGroups';
import type { FlowPreApprovalBinding } from './preApproval';
import type { StepExecutionInput, StepOutcome } from './stepExecutor';

export interface FleetStepDeps {
  /** The step's stored binding on this publication; 'invalid' when unreadable. */
  binding: FlowPreApprovalBinding | null | 'invalid';
  /** Park for approval with this (frozen) input. */
  park: (frozenInput: Record<string, FlowValue>) => Promise<StepOutcome>;
  /** Run the dispatch inside the run's flow frame, raced against the step deadline. */
  run: (fn: () => Promise<StepOutcome>, meta: { renderedInput: Record<string, FlowValue>; approvalMode?: 'pre_approved' }) => Promise<StepOutcome>;
}

type Meta = { renderedInput: Record<string, FlowValue>; approvalMode?: 'pre_approved' };

function policy(code: 'drift' | 'binding_drift' | 'reference_not_owned', message: string, meta: Meta): StepOutcome {
  return { kind: 'failed', code, message, policy: true, ...meta };
}

function emptyOutput(warnings: string[]): FlowValue {
  const output: FlowFleetStepOutput = {
    dispatchedDeviceIds: [], succeededDeviceIds: [], failedDeviceIds: [], skippedOfflineDeviceIds: [], count: 0, warnings,
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
  if (deps.binding === 'invalid') return policy('drift', 'This step\'s stored pre-approval is unreadable.', meta);

  const selection = await resolveFleetSelection(input, ctx);
  if (selection.kind === 'outcome') {
    const o = selection.outcome;
    return o.kind === 'skipped' ? o : { ...o, ...meta };
  }

  const bound = deps.binding;
  if (bound && bound.lane !== 'fleet') {
    // A fleet step can only carry a fleet binding; anything else is not what was enabled.
    return policy('binding_drift', 'This step no longer matches its pre-approval.', meta);
  }
  if (bound && honoursFleetPreApproval(i.run)) {
    return executePreApprovedFleet(i, input, selection, bound, ctx, deps);
  }

  if (selection.requested.length === 0) {
    return { kind: 'completed', output: emptyOutput(selection.warnings), truncated: false, ...meta };
  }
  return deps.park(frozenInputOf(input, selection.requested));
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
