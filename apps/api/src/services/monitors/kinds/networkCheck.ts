import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  checkType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  target: string;
  port?: number;
  expectStatus?: number;
  pollingIntervalSeconds: number;
  timeoutSeconds: number;
  consecutiveFailures: number;
};

/**
 * `network_check` (#5287 W04, #5291) — the one ADAPTER kind.
 *
 * Besides the usual three managed rows the compiler also upserts a managed
 * `network_monitors` row for this kind; the existing `monitorWorker` polls it
 * from an agent and `networkCheckHandler` reads the verdict back off
 * `network_monitor_results`. `checkType` reuses the `monitor_type` pgEnum
 * labels verbatim, so no vocabulary is mapped anywhere.
 *
 * `agentDelivered: true` — the check itself runs FROM an agent.
 *
 * `target` and `checkType` are deliberately NOT overridable: a config-policy
 * attachment that could repoint the probe would let one tenant's policy aim
 * another tenant's agent at an arbitrary host. Same reasoning as `scriptId` on
 * the `script` kind.
 */
export const networkCheckKind: MonitorKindSpec<C> = {
  kind: 'network_check',
  conditionSchema: monitorConditionSchemas.network_check,
  overridableKeys: ['pollingIntervalSeconds', 'consecutiveFailures'],
  defaultSeverity: 'high',
  agentDelivered: true,
  titleTemplate: 'Network check {{ruleName}} failing',
  messageTemplate: '{{ruleName}}: network check has been offline for {{actualValue}} consecutive result(s)',
  // The compiled condition carries the MONITOR's id, not the managed
  // network_monitors row's: the managed row is found through
  // `managed_by_monitor_id`, which keeps the condition stable across a
  // recompile that happens to re-provision the row.
  toAlertCondition: (c, ctx) => ({
    type: 'network_check',
    monitorId: ctx.monitorId,
    consecutiveFailures: c.consecutiveFailures,
  }),
};
