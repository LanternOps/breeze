import type { ALERT_SEVERITIES } from '../../constants';
import type { DeploymentTargetConfig } from '../../types/filters';
import type { FlowWebhookOrgResolver } from '../../validators/flows';

/**
 * The values the guided flow form edits (flows completion W01a). A form is a
 * deliberately small subset of the document: one trigger, one target, an
 * ordered list of script / notify / alert actions and an on-failure rule.
 * Anything outside that subset is a document the form refuses to open for
 * editing (`recognizeFlowForm`).
 */
export type FlowFormTrigger =
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'event'; event: string; filter: Record<string, string | number | boolean> }
  | { type: 'webhook'; auth: 'hmac' | 'token'; orgResolver?: FlowWebhookOrgResolver }
  | { type: 'manual' };

export type FlowFormTarget = { kind: 'trigger_device' } | { kind: 'target'; target: DeploymentTargetConfig };

export type FlowFormAction =
  | { type: 'run_script'; scriptId: string; parameters?: Record<string, string | number | boolean>; runAs?: 'system' | 'user'; whenOffline: 'queue' | 'skip' }
  | { type: 'notify'; channelId: string; title: string; message: string; severity: 'info' | 'warning' | 'critical' }
  | { type: 'create_alert'; severity: (typeof ALERT_SEVERITIES)[number]; title: string; message: string };

/**
 * How the on-failure notice is shaped (#12596). `summary`: one notice per
 * channel for each script step that had failures, with the succeeded and
 * failed counts; what the editor creates. `perDevice`: one notice per channel
 * for each failed device, the legacy-Job converter's shape; kept so a flow
 * moved from a Job saves unchanged. Decoded from the document, never defaulted.
 */
export type FlowFormFailureNotice = 'summary' | 'perDevice';

export type FlowFormOnFailure =
  | { mode: 'stop' }
  | { mode: 'continue' }
  | { mode: 'notify'; channelIds: string[]; notice: FlowFormFailureNotice };

export interface FlowFormValues {
  name: string;
  description?: string;
  trigger: FlowFormTrigger;
  target: FlowFormTarget;
  actions: FlowFormAction[];
  onFailure: FlowFormOnFailure;
}
