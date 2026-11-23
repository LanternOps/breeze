import { FLEET_MAX_TARGETS } from '../../validators/flowConversions';
import type { FlowDocumentV1 } from '../../validators/flows';

/**
 * Step emitters shared by the guided flow form (`compileFlowForm`) and the
 * legacy-Job converter (API `convertAutomation`). They are the converter's own
 * shapes (W06 plan, "Conversion map"), moved here unchanged: the converter's
 * output bytes, including JSON key order, must not change, and the form
 * recognizer relies on these exact shapes. Pure and browser safe.
 */
export type FlowStep = FlowDocumentV1['steps'][number];

/** Which device set a following step chains on: `succeeded` under stop or notify, `dispatched` under continue. */
export type FleetChainSet = 'succeeded' | 'dispatched';

/** The set of devices the next device-level step acts on: a `resolve_targets` step or a fleet (script) step. */
export interface ActiveSet {
  stepId: string;
  kind: 'resolve' | 'fleet';
}

/** A step with the converter's defaults (approval default, onFailure continue, timeout 300 s). Key order is part of the contract. */
export function flowStep(s: Omit<FlowStep, 'approval' | 'onFailure' | 'timeoutSec'> & Partial<FlowStep>): FlowStep {
  return { approval: 'default', onFailure: 'continue', timeoutSec: 300, ...s } as FlowStep;
}

/** The `targets` step: resolve the selector to devices. Stops the flow when it fails. */
export function emitTargetsStep(selectorInput: Record<string, unknown>): FlowStep {
  return flowStep({ id: 'targets', tool: 'resolve_targets', input: selectorInput, onFailure: 'stop' });
}

/** One script (or generated command) dispatched to the devices `input` selects. `i` is the action index. */
export function emitRunScriptStep(i: number, kind: 'run_script' | 'command', input: Record<string, unknown>): FlowStep {
  return flowStep({ id: `a${i}_${kind}`, tool: 'run_script_on_targets', input, timeoutSec: 3600 });
}

/**
 * The for-each items (devices with hostnames) of the current active set, and
 * any resolve step needed to get them. A `resolve` active set already carries
 * the devices; with no active set a `targets` step is added; a fleet set gets
 * an `a<i>_devices` step over its `chainSet`. The active set after a fleet
 * set's `a<i>_devices` step is unchanged (the converter's behaviour).
 */
export function emitDeviceItems(
  i: number,
  active: ActiveSet | null,
  selectorInput: Record<string, unknown>,
  chainSet: FleetChainSet,
): { steps: FlowStep[]; items: string; active: ActiveSet } {
  if (active?.kind === 'resolve') return { steps: [], items: `steps.${active.stepId}.output.devices`, active };
  if (!active) {
    const next: ActiveSet = { stepId: 'targets', kind: 'resolve' };
    return { steps: [emitTargetsStep(selectorInput)], items: 'steps.targets.output.devices', active: next };
  }
  const id = `a${i}_devices`;
  return {
    steps: [flowStep({ id, tool: 'resolve_targets', input: { fromStep: { stepId: active.stepId, set: chainSet } } })],
    items: `steps.${id}.output.devices`,
    active,
  };
}

/** One alert per device of `items`. The caller has already bounded `title` and `message`. */
export function emitCreateAlertStep(i: number, items: string, alert: { severity: string; title: string; message: string }): FlowStep {
  return flowStep({
    id: `a${i}_alert`,
    tool: 'create_alert',
    forEach: { items, as: 'item', maxItems: FLEET_MAX_TARGETS, concurrency: 1 },
    input: { deviceId: '{{item.id}}', severity: alert.severity, title: alert.title, message: alert.message },
  });
}

/**
 * The on-failure block after a fleet step: one `a<i>_failed` resolve step for
 * the devices that failed, then one notice per channel, per failed device.
 * Both run only when at least one device failed. Empty for no channels.
 */
export function emitFailureNoticeSteps(i: number, fleetStepId: string, flowName: string, channelIds: string[]): FlowStep[] {
  if (channelIds.length === 0) return [];
  const when = `length(steps.${fleetStepId}.output.failedDeviceIds) > 0`;
  const failedId = `a${i}_failed`;
  const steps: FlowStep[] = [
    flowStep({ id: failedId, tool: 'resolve_targets', input: { fromStep: { stepId: fleetStepId, set: 'failed' } }, when }),
  ];
  channelIds.forEach((channelId, n) => {
    steps.push(flowStep({
      id: `a${i}_failnotice_${n}`,
      tool: 'notify',
      when,
      forEach: { items: `steps.${failedId}.output.devices`, as: 'item', maxItems: FLEET_MAX_TARGETS, concurrency: 1 },
      input: {
        channelId,
        title: `${flowName} action failed`,
        message: `Automation ${flowName} action ${i + 1} failed on {{item.hostname}}: {{item.failureReason}}`,
        severity: 'warning',
      },
    }));
  });
  return steps;
}
