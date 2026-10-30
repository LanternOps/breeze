/**
 * Tool Catalog W06 (#5221) Task A4 — the `resolve_targets` built-in (Tier 1,
 * `devices.read`): a target, a legacy condition array, explicit device ids, or
 * an earlier fleet step's device set, resolved once in the run org. Its output is the fleet
 * shape with every set equal to the resolved set, plus each device's hostname
 * and display name (converted Jobs' per-device notices and alerts read them).
 *
 * Refusals are policy failures (they end the run, like a legacy run that
 * dispatched nothing): a broken target is `targets_unresolvable` with the
 * legacy diagnostic text; more than FLEET_MAX_TARGETS devices is
 * `targets_over_cap` — the set is never truncated.
 */
import { FLEET_MAX_TARGETS, type FlowFleetStepOutput, type FlowValue, type LegacyCondition, type DeploymentTargetConfig } from '@breeze/shared';
import type { StepOutcome } from '../stepExecutor';
import { resolveDeviceIdsInRunOrg, resolveTargetsOnce, type FleetDevice } from './fleetTargets';
import { loadFleetStepOutput } from './stepOutputs';
import type { BuiltinContext } from './types';

export type ResolveTargetsInput =
  | { target: DeploymentTargetConfig; conditions?: undefined; deviceIds?: undefined; fromStep?: undefined }
  | { conditions: LegacyCondition[]; target?: undefined; deviceIds?: undefined; fromStep?: undefined }
  | { deviceIds: string[]; target?: undefined; conditions?: undefined; fromStep?: undefined }
  | { fromStep: { stepId: string; set: 'succeeded' | 'dispatched' | 'failed' }; target?: undefined; conditions?: undefined; deviceIds?: undefined };

function policyFailure(code: 'targets_unresolvable' | 'targets_over_cap', message: string): StepOutcome {
  return { kind: 'failed', code, message, policy: true };
}

export function overCapMessage(count: number): string {
  return `The target resolved to ${count} devices; a flow step may target at most ${FLEET_MAX_TARGETS}. Nothing was run.`;
}

export async function executeResolveTargets(input: ResolveTargetsInput, ctx: BuiltinContext): Promise<StepOutcome> {
  const run = { orgId: ctx.run.orgId, partnerId: ctx.auth.partnerId! };
  let found: FleetDevice[];
  let warnings: string[] = [];
  if (input.fromStep) {
    const sets = await loadFleetStepOutput(ctx.run.id, input.fromStep.stepId);
    if (!sets) {
      return policyFailure('targets_unresolvable', `Step '${input.fromStep.stepId}' has no device set to read.`);
    }
    const ids = input.fromStep.set === 'succeeded' ? sets.succeededDeviceIds
      : input.fromStep.set === 'dispatched' ? sets.dispatchedDeviceIds
        : sets.failedDeviceIds;
    if (ids.length > FLEET_MAX_TARGETS) return policyFailure('targets_over_cap', overCapMessage(ids.length));
    found = await resolveDeviceIdsInRunOrg(run, ids);
  } else if (input.deviceIds) {
    // Explicit ids (rendered templates included), kept to the run org's devices like a fromStep set.
    if (input.deviceIds.length > FLEET_MAX_TARGETS) return policyFailure('targets_over_cap', overCapMessage(input.deviceIds.length));
    found = await resolveDeviceIdsInRunOrg(run, input.deviceIds);
  } else {
    const resolved = await resolveTargetsOnce(run, input.target ? { target: input.target } : { conditions: input.conditions! });
    if (resolved.problems.length > 0) {
      return policyFailure('targets_unresolvable', resolved.problems.join('; '));
    }
    if (resolved.deviceIds.length > FLEET_MAX_TARGETS) {
      return policyFailure('targets_over_cap', overCapMessage(resolved.deviceIds.length));
    }
    found = resolved.devices;
    warnings = resolved.warnings;
  }
  const ids = found.map((d) => d.id);
  const output: FlowFleetStepOutput = {
    dispatchedDeviceIds: ids,
    succeededDeviceIds: ids,
    failedDeviceIds: [],
    skippedOfflineDeviceIds: [],
    devices: found,
    count: ids.length,
    warnings,
  };
  return { kind: 'completed', output: output as unknown as FlowValue, truncated: false };
}
