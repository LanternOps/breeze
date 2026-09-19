import { monitorConditionSchemas } from '@breeze/shared';
import type { MonitorKindSpec } from './types';

type C = {
  scriptId: string;
  intervalMinutes: number;
  timeoutSeconds: number;
  parameters?: Record<string, unknown>;
  breachOnNonZeroExit: boolean;
};

/**
 * `script` monitor kind (#5291 W04).
 *
 * Unlike every other kind, this one has no data to read until something runs
 * the script — the SERVER dispatches it (`jobs/monitorScriptWorker.ts`, on
 * its own interval), the agent just executes it like any other script run.
 * That is why `agentDelivered` is `false`: this is not the agent-delivered
 * watch path (service/process monitors report their own breaches), it is a
 * server-side sweep + dispatch, evaluated afterwards by
 * `alertConditions/handlers/scriptMonitor.ts` against the resulting
 * `script_executions` row.
 */
export const scriptKind: MonitorKindSpec<C> = {
  kind: 'script',
  conditionSchema: monitorConditionSchemas.script,
  // `scriptId` is deliberately NOT overridable. A config-policy attachment
  // that could swap the script a monitor runs would let an override at a
  // lower level (site/device-group/device) point a partner-wide monitor at a
  // DIFFERENT script than the one authoring authorized — effectively a
  // cross-tenant code-execution vector past `buildDiagnosticScriptReferences`
  // (monitorCompiler.ts)'s ownership-binding guard, which only ever checks
  // the script named in the STORED condition. `intervalMinutes` and
  // `timeoutSeconds` are pure scheduling/execution knobs with no such risk.
  overridableKeys: ['intervalMinutes', 'timeoutSeconds'],
  defaultSeverity: 'medium',
  agentDelivered: false,
  titleTemplate: 'Script Monitor on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{description}}',
  // `ctx.monitorId` is `monitor_definitions.id` (see `MonitorCompileContext`,
  // kinds/types.ts) — required here because the handler's evidence
  // (`script_executions.monitor_id`) is stamped with the MONITOR's id, not
  // anything derivable from the authored condition alone.
  toAlertCondition: (c, ctx) => ({
    type: 'script_monitor',
    monitorId: ctx.monitorId,
    intervalMinutes: c.intervalMinutes,
    breachOnNonZeroExit: c.breachOnNonZeroExit,
  }),
};
