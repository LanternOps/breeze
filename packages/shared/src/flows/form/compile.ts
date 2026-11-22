import type { FlowDocumentV1 } from '../../validators/flows';
import {
  emitCreateAlertStep,
  emitDeviceItems,
  emitFailureNoticeSteps,
  emitRunScriptStep,
  flowStep,
  type ActiveSet,
  type FleetChainSet,
  type FlowStep,
} from './emit';
import type { FlowFormTrigger, FlowFormValues } from './types';

/** The line `compileFlowForm` appends to a notice that follows a script; `decodeFlowForm` strips exactly this. */
export function deviceCountsSuffix(scriptStepId: string): string {
  return `\n\nDevices: {{steps.${scriptStepId}.output.succeededCount}} succeeded, {{steps.${scriptStepId}.output.failedCount}} failed.`;
}

export const TRIGGER_DEVICE_SELECTOR = { deviceIds: ['{{trigger.device.id}}'] } as const;

function compileTrigger(t: FlowFormTrigger): FlowDocumentV1['trigger'] {
  switch (t.type) {
    case 'schedule': return { type: 'schedule', cron: t.cron, timezone: t.timezone };
    case 'event': return { type: 'event', event: t.event, filter: { ...t.filter } };
    case 'webhook': return t.orgResolver ? { type: 'webhook', auth: t.auth, orgResolver: t.orgResolver } : { type: 'webhook', auth: t.auth };
    case 'manual': return { type: 'manual' };
  }
}

/**
 * Compiles guided-form values into a flow document, with the shapes the
 * legacy-Job converter proved (shared emitters). Deterministic. The document
 * has no `inputs`, `limits` or `notices`; a notify-only form has no `targets`
 * step; a notify action is one step (not per device) and, after a script,
 * carries the succeeded and failed device counts.
 */
export function compileFlowForm(values: FlowFormValues): FlowDocumentV1 {
  const selectorInput: Record<string, unknown> = values.target.kind === 'trigger_device'
    ? { deviceIds: [...TRIGGER_DEVICE_SELECTOR.deviceIds] }
    : { target: values.target.target };
  const chainSet: FleetChainSet = values.onFailure.mode === 'continue' ? 'dispatched' : 'succeeded';
  const failureChannels = values.onFailure.mode === 'notify' ? values.onFailure.channelIds : [];

  const steps: FlowStep[] = [];
  let active: ActiveSet | null = null;
  let lastScriptStepId: string | null = null;

  values.actions.forEach((a, i) => {
    if (a.type === 'run_script') {
      const input: Record<string, unknown> = { scriptId: a.scriptId };
      if (a.parameters && Object.keys(a.parameters).length > 0) input.parameters = a.parameters;
      if (a.runAs) input.runAs = a.runAs;
      input.whenOffline = a.whenOffline;
      Object.assign(input, active ? { fromStep: { stepId: active.stepId, set: chainSet } } : selectorInput);
      const step = emitRunScriptStep(i, 'run_script', input);
      steps.push(step, ...emitFailureNoticeSteps(i, step.id, values.name, failureChannels));
      active = { stepId: step.id, kind: 'fleet' };
      lastScriptStepId = step.id;
    } else if (a.type === 'create_alert') {
      const dev = emitDeviceItems(i, active, selectorInput, chainSet);
      steps.push(...dev.steps, emitCreateAlertStep(i, dev.items, { severity: a.severity, title: a.title, message: a.message }));
      active = dev.active;
    } else {
      const message = lastScriptStepId ? `${a.message}${deviceCountsSuffix(lastScriptStepId)}` : a.message;
      steps.push(flowStep({
        id: `a${i}_notify`,
        tool: 'notify',
        input: { channelId: a.channelId, title: a.title, message, severity: a.severity },
      }));
    }
  });

  const description = values.description?.trim() ? values.description : undefined;
  return {
    version: 1,
    name: values.name,
    ...(description !== undefined ? { description } : {}),
    trigger: compileTrigger(values.trigger),
    inputs: [],
    steps,
  };
}
