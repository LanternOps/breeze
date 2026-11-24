/**
 * What happens when an event of each type reaches a flow without a device
 * (#12497). Read from the engine, not decided here
 * (apps/api/src/services/flows/eventTrigger.ts); keep this in step with it.
 *
 * - `always`: the event always carries a device; nothing to say.
 * - `no_run`: an alert event with no device starts no run (`alert_has_no_device`).
 * - `fails`: the run starts and ends `failed` with `input_invalid`.
 *
 * The picker's list lives in `getEventTypeOptions` (AutomationForm.tsx);
 * eventDeviceHelp.test.tsx fails when an event there has no entry here.
 */
export type EventDeviceBehavior = 'always' | 'no_run' | 'fails';

export const EVENT_DEVICE_BEHAVIOR: Readonly<Record<string, EventDeviceBehavior>> = {
  'device.online': 'always',
  'device.offline': 'always',
  'alert.triggered': 'no_run',
  'alert.resolved': 'no_run',
  'script.completed': 'always',
  'script.failed': 'always',
  'policy.violation': 'always',
  'huntress.incident_created': 'fails',
  'huntress.incident_updated': 'fails',
  'huntress.agent_offline': 'fails',
  's1.threat_detected': 'fails',
  's1.device_isolated': 'always',
  's1.threat_action_completed': 'fails',
};

/** An event outside the picker (a hand-edited document) gets no extra line. */
export function eventDeviceBehavior(event: string): EventDeviceBehavior {
  return Object.prototype.hasOwnProperty.call(EVENT_DEVICE_BEHAVIOR, event) ? EVENT_DEVICE_BEHAVIOR[event]! : 'always';
}
