/**
 * Tool Catalog W06 (#5221) Task A7 — which engine class an `automations` row
 * belongs to (plan, Legacy inventory). Ordered; the first match wins:
 *
 *  - M: monitor-compiled (`managed_by_monitor_id`). Tested BEFORE A —
 *       monitor compilation can set both managed ids;
 *  - A: AI-agent triage (`managed_by_agent_id`);
 *  - P: a policy workflow (`trigger.filter._policyWorkflow`);
 *  - S: a standalone Job — everything else that is not retired.
 *
 * Only S converts in W06; M, A and P stay on the legacy engine core. A
 * retired S row is `retired` (nothing to convert).
 */
export type AutomationClass = 'M' | 'A' | 'P' | 'S';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isPolicyWorkflowTrigger(trigger: unknown): boolean {
  return isRecord(trigger) && isRecord(trigger.filter) && Object.hasOwn(trigger.filter, '_policyWorkflow');
}

export function classifyAutomation(row: {
  managedByMonitorId: string | null;
  managedByAgentId: string | null;
  trigger: unknown;
  retiredAt: Date | null;
}): AutomationClass | 'retired' {
  if (row.managedByMonitorId) return 'M';
  if (row.managedByAgentId) return 'A';
  if (isPolicyWorkflowTrigger(row.trigger)) return 'P';
  return row.retiredAt ? 'retired' : 'S';
}
