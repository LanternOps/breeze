/**
 * Tool Catalog W06 (#5221) Task A5 — the `run_script_on_targets` built-in
 * (Tier 3, the `run_script` permission set): one library script dispatched to
 * a device set resolved ONCE in the run org, with the legacy dispatch
 * guarantees (services/scriptFleetDispatch.ts).
 *
 * Selectors: a target, a legacy condition array, a literal / templated device
 * list (`['{{trigger.device.id}}']`), or an earlier fleet step's set
 * (`fromStep`). On release (an approved parked step) the release worker hands
 * the VERIFIED context — the script snapshot it re-checked and the device list
 * frozen at intent creation — and exactly those devices are dispatched; no
 * selector is re-resolved.
 *
 * The output carries the id sets and counts only (per-device detail lives in
 * the device rows), so it stays far below the release worker's 64 KiB result
 * cap at 500 devices:
 *  - dispatchedDeviceIds: every device the step attempted (`continue` chains on it);
 *  - succeededDeviceIds: attempted and not failed (`stop`/`notify` chain on it —
 *    the legacy active set; a maintenance-skipped device stays in it);
 *  - failedDeviceIds: dispatch failures, offline-under-skip devices (legacy
 *    records those failed) and devices refused because the run org does not
 *    hold them;
 *  - skippedOfflineDeviceIds: the offline-under-skip subset.
 * Any failed device fails the step (`script_dispatch_failed`, onFailure
 * applies) and the output still carries every set, so later steps chain.
 */
import {
  FLEET_MAX_TARGETS,
  type DeploymentTargetConfig,
  type FlowFleetStepOutput,
  type FlowValue,
  type LegacyCondition,
} from '@breeze/shared';
import { dispatchScriptToDevices } from '../../scriptFleetDispatch';
import type { StepOutcome } from '../stepExecutor';
import { resolveDeviceIdsInRunOrg, resolveTargetsOnce } from './fleetTargets';
import { loadOwnedScriptForRun, loadRunVariableScope, type FleetScriptRow } from './fleetScripts';
import { overCapMessage } from './resolveTargets';
import { loadFleetStepOutput } from './stepOutputs';
import type { BuiltinContext } from './types';

export interface RunScriptOnTargetsInput {
  scriptId: string;
  parameters?: Record<string, unknown>;
  runAs?: 'system' | 'user';
  whenOffline: 'queue' | 'skip';
  target?: DeploymentTargetConfig;
  conditions?: LegacyCondition[];
  deviceIds?: string[];
  fromStep?: { stepId: string; set: 'succeeded' | 'dispatched' };
}

/** What the release worker re-verified under its dispatch claim (A6). */
export interface FleetVerifiedContext {
  script: FleetScriptRow;
  /** The device list frozen when the approval intent was created. */
  deviceIds: string[];
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

function policy(code: 'targets_unresolvable' | 'targets_over_cap' | 'reference_not_owned' | 'tool_blocked' | 'binding_drift', message: string): StepOutcome {
  return { kind: 'failed', code, message, policy: true };
}

export async function executeRunScriptOnTargets(
  input: RunScriptOnTargetsInput,
  ctx: BuiltinContext,
  verified?: FleetVerifiedContext,
): Promise<StepOutcome> {
  const run = { id: ctx.run.id, orgId: ctx.run.orgId, partnerId: ctx.auth.partnerId! };

  // 1. The script: the verified snapshot on release, else the owner's live library row.
  let script: FleetScriptRow | null;
  if (verified) {
    if (verified.script.id !== input.scriptId) {
      return policy('binding_drift', 'The approved script is not the script this step names.');
    }
    script = verified.script;
  } else {
    script = await loadOwnedScriptForRun(ctx.owner, input.scriptId);
  }
  if (!script) return policy('reference_not_owned', 'The script this step names is not available to the flow\'s owner.');
  // An EFFECTIVE elevated context is refused — explicit or inherited from the saved script.
  if ((input.runAs ?? script.runAs) === 'elevated') {
    return policy('tool_blocked', 'This script runs elevated; a flow step cannot run it. Choose system or user.');
  }

  // 2. The device set, resolved once.
  let requested: string[];
  let found: string[];
  let warnings: string[] = [];
  if (verified || input.deviceIds || input.fromStep) {
    let ids: string[];
    if (verified) {
      ids = verified.deviceIds;
    } else if (input.deviceIds) {
      ids = input.deviceIds;
    } else {
      const sets = await loadFleetStepOutput(ctx.run.id, input.fromStep!.stepId);
      if (!sets) return policy('targets_unresolvable', `Step '${input.fromStep!.stepId}' has no device set to read.`);
      ids = input.fromStep!.set === 'succeeded' ? sets.succeededDeviceIds : sets.dispatchedDeviceIds;
    }
    requested = sorted(ids);
    if (requested.length > FLEET_MAX_TARGETS) return policy('targets_over_cap', overCapMessage(requested.length));
    found = sorted((await resolveDeviceIdsInRunOrg(run, requested)).map((d) => d.id));
  } else {
    const resolved = await resolveTargetsOnce(run, input.target ? { target: input.target } : { conditions: input.conditions ?? [] });
    if (resolved.problems.length > 0) return policy('targets_unresolvable', resolved.problems.join('; '));
    requested = sorted(resolved.deviceIds);
    if (requested.length > FLEET_MAX_TARGETS) return policy('targets_over_cap', overCapMessage(requested.length));
    found = requested;
    warnings = resolved.warnings;
  }
  const refused = requested.filter((id) => !found.includes(id));

  // 3. Dispatch exactly the checked set.
  const result = found.length === 0
    ? { perDevice: [], stopped: null }
    : await dispatchScriptToDevices({
      run,
      stepId: ctx.step.id,
      leaseToken: ctx.leaseToken,
      auth: ctx.auth,
      delegatorUserId: ctx.version.enabledByUserId ?? null,
      script,
      parameters: input.parameters ?? {},
      runAs: input.runAs ?? null,
      offlinePolicy: input.whenOffline,
      deviceIds: found,
      variableScope: await loadRunVariableScope(script, run.orgId),
    });

  // 4. The sets.
  const attempted = result.perDevice.map((d) => d.deviceId);
  const failedNow = result.perDevice.filter((d) => d.outcome === 'failed' || d.outcome === 'skipped_offline').map((d) => d.deviceId);
  const failed = sorted([...refused, ...failedNow]);
  const failedSet = new Set(failed);
  const output: FlowFleetStepOutput = {
    dispatchedDeviceIds: sorted(attempted),
    succeededDeviceIds: sorted(attempted.filter((id) => !failedSet.has(id))),
    failedDeviceIds: failed,
    skippedOfflineDeviceIds: sorted(result.perDevice.filter((d) => d.outcome === 'skipped_offline').map((d) => d.deviceId)),
    count: requested.length,
    warnings,
  };
  const out = output as unknown as FlowValue;

  if (result.stopped === 'lease_lost') {
    return { kind: 'unknown_outcome', message: `The worker lost the run after dispatching to ${attempted.length} of ${requested.length} devices.` };
  }
  if (result.stopped === 'cancelled') {
    return { kind: 'failed', code: 'cancelled', message: `The run was cancelled after ${attempted.length} of ${requested.length} devices.`, policy: true, output: out };
  }
  if (failed.length > 0) {
    const first = result.perDevice.find((d) => d.error && failedSet.has(d.deviceId))?.error
      ?? (refused.length > 0 ? 'a device is not in the run\'s organization' : 'dispatch failed');
    return {
      kind: 'failed',
      code: 'script_dispatch_failed',
      message: `The script failed on ${failed.length} of ${requested.length} devices (first: ${first.slice(0, 200)}).`,
      policy: false,
      output: out,
    };
  }
  return { kind: 'completed', output: out, truncated: false };
}
