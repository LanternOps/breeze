/**
 * Creation-time remediation causes. Deliberately a superset of
 * AI_AGENT_TRIGGER_KINDS and compatible with audit initiators; neither existing
 * catalog is replaced. Keys group conditions; occurrence ids identify rows.
 */
export const REMEDIATION_TRIGGER_KINDS = [
  'manual', 'schedule', 'sweep_finding', 'alert', 'monitor',
  'fleet_finding', 'policy', 'automation', 'ticket', 'anomaly', 'api',
] as const;
export type RemediationTriggerKind = (typeof REMEDIATION_TRIGGER_KINDS)[number];
export interface RemediationTrigger {
  kind: RemediationTriggerKind;
  /** Occurrence row, deliberately without a foreign key. */
  refId?: string | null;
  /** Stable semantic key; use the builders below. */
  key?: string | null;
}
export const REMEDIATION_TRIGGER_KEY_MAX = 200;

/** Total for string arrays: normalize whitespace, lowercase kind/facets,
 * preserve subject case, omit empty parts, and cap without throwing. */
export function buildTriggerKey(parts: readonly string[]): string {
  return parts.map((part, index) => {
    const normalized = part.trim().replace(/\s+/g, ' ');
    return index === 0 || index < parts.length - 1 ? normalized.toLowerCase() : normalized;
  }).filter(Boolean).join(':').slice(0, REMEDIATION_TRIGGER_KEY_MAX);
}
export function sweepTriggerKey(sweepKind: string, subjectKey: string): string {
  return buildTriggerKey(['sweep', sweepKind, subjectKey]);
}
export function alertTriggerKey(configItemName: string | null, ruleId: string | null): string {
  return configItemName?.trim()
    ? buildTriggerKey(['alert', configItemName, ''])
    : buildTriggerKey(['alert', ruleId ?? '']);
}
export function monitorTriggerKey(builtinKeyOrId: string): string {
  return buildTriggerKey(['monitor', builtinKeyOrId]);
}
