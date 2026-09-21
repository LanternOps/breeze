import { createHash } from 'node:crypto';
import { SERVER_EVALUATED_MONITOR_KINDS, type MonitorKind } from '@breeze/shared';
import type { alertRules, alertTemplates } from '../../../db/schema/alerts';
import type { automations } from '../../../db/schema/automations';
import type { configPolicyAlertRules, configPolicyMonitoringWatches } from '../../../db/schema/configurationPolicies';
import { normalizeMetricName } from '../../alertConditions/utils';
import { getMonitorKindSpec } from '../kinds';
import { convertAlertConditionToMonitor } from '../monitorConversion';
import type { ConversionPreviewItem, ProposedMonitor } from './types';

export const UNCONVERTIBLE = {
  metricWithoutKind: 'metric_without_kind',
  custom: 'custom_condition',
  nestedGroup: 'nested_group',
  childNotComposable: 'child_kind_not_composable',
  tooManyConditions: 'too_many_conditions',
  tooManyResponses: 'too_many_responses',
  noCondition: 'no_condition',
  autoResolveConditions: 'auto_resolve_conditions',
  escalationPolicyAxis: 'escalation_policy_axis',
} as const;

export type MappingResult =
  | { ok: true; proposed: ProposedMonitor[]; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const fail = (code: string, notes: string[] = []): MappingResult => ({ ok: false, reason: `unconvertible:${code}`, notes });

export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Why a single leaf did not convert — mirrors convertAlertConditionToMonitor's null branches. */
function leafFailureCode(leaf: Record<string, unknown>): string {
  const type = typeof leaf.type === 'string' ? leaf.type : '';
  if (type === 'custom') return UNCONVERTIBLE.custom;
  if (type === 'metric' || type === 'threshold') {
    const metric = normalizeMetricName(String(leaf.metric ?? ''));
    if (metric === 'processCount' || metric === null) return UNCONVERTIBLE.metricWithoutKind;
  }
  return UNCONVERTIBLE.noCondition;
}

/** The legacy evaluator accepts metric aliases; the existing converter expects DB names. */
function mapLeaf(leaf: unknown) {
  if (isRecord(leaf) && (leaf.type === 'metric' || leaf.type === 'threshold')) {
    return convertAlertConditionToMonitor([{ ...leaf, metric: normalizeMetricName(String(leaf.metric ?? '')) }]);
  }
  return convertAlertConditionToMonitor([leaf]);
}

function mapConditions(conditions: unknown): { kind: MonitorKind; condition: Record<string, unknown> } | { code: string } {
  let leaves: unknown[];
  let match: 'all' | 'any' = 'all';
  if (Array.isArray(conditions)) {
    leaves = conditions;
  } else if (isRecord(conditions) && 'logic' in conditions && Array.isArray(conditions.conditions)) {
    match = conditions.logic === 'or' ? 'any' : 'all';
    leaves = conditions.conditions;
  } else if (isRecord(conditions)) {
    leaves = [conditions];
  } else {
    return { code: UNCONVERTIBLE.noCondition };
  }
  if (leaves.length === 0) return { code: UNCONVERTIBLE.noCondition };
  if (leaves.length > 10) return { code: UNCONVERTIBLE.tooManyConditions };
  if (leaves.some((l) => isRecord(l) && ('logic' in l || 'conditions' in l))) return { code: UNCONVERTIBLE.nestedGroup };

  if (leaves.length === 1) {
    const one = mapLeaf(leaves[0]);
    if (!one) return { code: isRecord(leaves[0]) ? leafFailureCode(leaves[0]) : UNCONVERTIBLE.noCondition };
    return one;
  }

  const children: Array<{ kind: MonitorKind; condition: Record<string, unknown> }> = [];
  for (const leaf of leaves) {
    const child = mapLeaf(leaf);
    if (!child) return { code: isRecord(leaf) ? leafFailureCode(leaf) : UNCONVERTIBLE.noCondition };
    if (!(SERVER_EVALUATED_MONITOR_KINDS as readonly string[]).includes(child.kind)) return { code: UNCONVERTIBLE.childNotComposable };
    children.push(child);
  }
  const composite = getMonitorKindSpec('composite').conditionSchema.safeParse({ match, children });
  if (!composite.success) return { code: UNCONVERTIBLE.noCondition };
  return { kind: 'composite', condition: composite.data as Record<string, unknown> };
}

export function mapInlineRule(row: typeof configPolicyAlertRules.$inferSelect): MappingResult {
  const notes: string[] = [];
  if (Array.isArray(row.autoResolveConditions) && row.autoResolveConditions.length > 0) {
    return fail(UNCONVERTIBLE.autoResolveConditions, ['Custom auto-resolve conditions have no monitor equivalent; retire or re-author.']);
  }
  const mapped = mapConditions(row.conditions);
  if ('code' in mapped) return fail(mapped.code);
  notes.push("Title/message use the monitor kind's templates; the rule's titleTemplate/messageTemplate are not carried.");
  const channelIds = Array.isArray(row.notificationChannelIds) ? row.notificationChannelIds : [];
  return {
    ok: true,
    notes,
    proposed: [{
      role: 'primary',
      enabled: true,
      kind: mapped.kind,
      name: row.name,
      condition: mapped.condition,
      severity: row.severity,
      cooldownMinutes: row.cooldownMinutes,
      autoResolve: row.autoResolve,
      deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
      deliveryChannelIds: channelIds,
      escalationPolicyId: row.escalationPolicyId ?? null,
      responses: [],
      ...(row.rationale ? { description: row.rationale } : {}),
    }],
  };
}

export function mapWatch(row: typeof configPolicyMonitoringWatches.$inferSelect): MappingResult {
  const kind: MonitorKind = row.watchType === 'service' ? 'service' : 'process';
  const spec = getMonitorKindSpec(kind);
  const notes: string[] = [];
  const responses: unknown[] = row.autoRestart
    ? [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: row.maxRestartAttempts, cooldownSeconds: row.restartCooldownSeconds, whenOffline: 'queue' }]
    : [];
  notes.push(`Legacy watches never raised an inbox alert (the monitoring-results ingest only counts failures); the monitor raises a ${spec.defaultSeverity} alert after ${row.alertAfterConsecutiveFailures} consecutive failures.`);
  if (row.autoRestart) notes.push(`Auto-restart stays agent-local (max ${row.maxRestartAttempts} attempts, ${row.restartCooldownSeconds}s cooldown) as a restart_service response.`);
  if (!row.alertOnStop) notes.push('alertOnStop=false was stored but never read at runtime; ignored.');

  const base = { enabled: row.enabled, severity: spec.defaultSeverity, cooldownMinutes: 5, autoResolve: false, deliveryMode: 'inherit' as const, deliveryChannelIds: [], escalationPolicyId: null };
  const durationMinutes = row.thresholdDurationSeconds > 0 ? Math.ceil(row.thresholdDurationSeconds / 60) : undefined;
  const proposed: ProposedMonitor[] = [{
    ...base, role: 'primary', kind, name: row.name, responses,
    condition: kind === 'service'
      ? { serviceName: row.name, consecutiveFailures: row.alertAfterConsecutiveFailures }
      : { processName: row.name, consecutiveFailures: row.alertAfterConsecutiveFailures },
  }];
  const resourceSpec = getMonitorKindSpec('process_resource');
  if (row.cpuThresholdPercent != null) {
    proposed.push({ ...base, role: 'resource_cpu', kind: 'process_resource', name: `${row.name} — CPU`, severity: resourceSpec.defaultSeverity, responses: [],
      condition: { resource: 'cpu', processName: row.name, operator: 'gt', value: row.cpuThresholdPercent, ...(durationMinutes ? { durationMinutes } : {}) } });
  }
  if (row.memoryThresholdMb != null) {
    proposed.push({ ...base, role: 'resource_memory', kind: 'process_resource', name: `${row.name} — memory`, severity: resourceSpec.defaultSeverity, responses: [],
      condition: { resource: 'memory', processName: row.name, operator: 'gt', value: row.memoryThresholdMb, ...(durationMinutes ? { durationMinutes } : {}) } });
  }
  return { ok: true, proposed, notes };
}

export function mapStandaloneRule(rule: typeof alertRules.$inferSelect, template: typeof alertTemplates.$inferSelect): MappingResult {
  const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
  const mapped = mapConditions(overrides.conditions ?? template.conditions);
  if ('code' in mapped) return fail(mapped.code);
  const channelIds = Array.isArray(overrides.notificationChannelIds) ? (overrides.notificationChannelIds as string[]) : [];
  return {
    ok: true, notes: [],
    proposed: [{
      role: 'primary', enabled: rule.isActive, kind: mapped.kind, name: rule.name, condition: mapped.condition,
      severity: (overrides.severity as ProposedMonitor['severity'] | undefined) ?? template.severity,
      cooldownMinutes: (overrides.cooldownMinutes as number | undefined) ?? template.cooldownMinutes,
      autoResolve: template.autoResolve,
      deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
      deliveryChannelIds: channelIds,
      escalationPolicyId: (overrides.escalationPolicyId as string | undefined) ?? null,
      responses: [],
      ...(template.description ? { description: template.description } : {}),
    }],
  };
}

export function mapAutomationResponses(row: typeof automations.$inferSelect): { actions: unknown[]; notes: string[] } {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  return { actions, notes: [`${actions.length} action(s) from automation "${row.name}" become monitor responses.`] };
}

const VOLATILE_ACTION_KEYS = new Set(['id', 'createdAt', 'updatedAt']);
export function fingerprintAction(action: unknown): string {
  if (!isRecord(action)) return sha(canonical(action));
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (!VOLATILE_ACTION_KEYS.has(k)) stripped[k] = v;
  return sha(canonical(stripped));
}

export function monitorSignature(m: Pick<ProposedMonitor, 'enabled' | 'kind' | 'condition' | 'severity' | 'cooldownMinutes' | 'autoResolve' | 'deliveryMode' | 'deliveryChannelIds' | 'escalationPolicyId' | 'responses'>): string {
  return sha(canonical({
    enabled: m.enabled, kind: m.kind, condition: m.condition, severity: m.severity, cooldownMinutes: m.cooldownMinutes, autoResolve: m.autoResolve,
    deliveryMode: m.deliveryMode, deliveryChannelIds: [...m.deliveryChannelIds].sort(), escalationPolicyId: m.escalationPolicyId,
    responses: (m.responses as unknown[]).map(fingerprintAction),
  }));
}

export function mergeResponseProposals(items: ConversionPreviewItem[]): ConversionPreviewItem[] {
  const out = structuredClone(items);
  for (const item of out) {
    if (!item.responseTargetSourceId || item.outcome !== 'convertible') continue;
    const target = out.find((i) => i.sourceId === item.responseTargetSourceId);
    const primary = target?.proposed.find((p) => p.role === 'primary');
    if (!target || target.outcome !== 'convertible' || !primary) {
      item.outcome = 'unconvertible'; item.reason = 'unconvertible:target_unconvertible'; continue;
    }
    const seen = new Set(primary.responses.map(fingerprintAction));
    const added = (item.responseActions ?? []).filter((a) => {
      const key = fingerprintAction(a); if (seen.has(key)) return false; seen.add(key); return true;
    });
    if (primary.responses.length + added.length > 10) {
      item.outcome = target.outcome = 'unconvertible';
      item.reason = target.reason = 'unconvertible:too_many_responses';
      continue;
    }
    primary.responses.push(...added);
    item.notes.push(`${added.length} actions appended to ${primary.name}; ${(item.responseActions ?? []).length - added.length} duplicates skipped`);
  }
  return out;
}

export function previewHash(input: { policyId: string; items: ConversionPreviewItem[]; inheritanceMode: string }): string {
  return sha(canonical({
    policyId: input.policyId,
    inheritanceMode: input.inheritanceMode,
    items: input.items.map((i) => ({ t: i.sourceTable, id: i.sourceId, o: i.outcome, r: i.reason ?? null, p: i.proposed.map(monitorSignature), actions: i.responseActions ?? [], workflow: i.workflow ?? null })),
  }));
}
