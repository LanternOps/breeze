/**
 * Event types a configuration policy automation can trigger on. Read by the
 * policy Automations tab and by the AI configuration-policy tool, so what a
 * person can pick and what the AI tool advertises cannot drift apart.
 *
 * Only events with a publisher belong here: an automation on an event nothing
 * publishes saves cleanly and never runs (#12710). The API contract test
 * `policyAutomationEventTypes.contract.test.ts` fails when an entry has no
 * publisher. `compliance.failed` and `patch.available` are deliberately absent:
 * nothing publishes either today.
 */
export const POLICY_AUTOMATION_EVENT_TYPES = [
  'device.offline',
  'device.online',
  'device.enrolled',
  'alert.triggered',
  'alert.resolved',
] as const;

export type PolicyAutomationEventType = (typeof POLICY_AUTOMATION_EVENT_TYPES)[number];
