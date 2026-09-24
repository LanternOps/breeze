/**
 * Typed alert-workflow filter helpers (#6367 W05c2 Task 9).
 *
 * `AutomationTrigger.filter` is a free-form `Record<string, unknown>`
 * (`automationWorker.ts`'s matcher reads it structurally, not through a fixed
 * schema) that already carries compatibility keys like `ruleId`,
 * `configPolicyAlertRuleId` and nested `device.*` filters. These two helpers
 * let the UI edit exactly the `severity` and `kind` dimensions without
 * disturbing anything else stored in the filter, and without introducing a
 * plural payload shape (`severities` / `monitorKinds`) the worker's matcher
 * cannot read.
 */
export type WorkflowFilter = Record<string, unknown>;

export function readWorkflowSelection(
  filter: WorkflowFilter | undefined,
  key: 'severity' | 'kind',
): string[] {
  const value = filter?.[key];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function writeWorkflowSelection(
  filter: WorkflowFilter | undefined,
  key: 'severity' | 'kind',
  values: string[],
): WorkflowFilter {
  const next = { ...filter };
  if (values.length) {
    next[key] = [...new Set(values)];
  } else {
    delete next[key];
  }
  return next;
}
