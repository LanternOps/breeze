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
/** What `parseSweepTriggerKey` recovers from a `sweep:<kind>:<subject>` key.
 *  `kind` is a bare string, not `AiSweepKind`: the catalog lives in
 *  `aiAgentSchedules.ts` and the caller narrows it (the API's
 *  `isActEligibleSweepKind`), so a key naming a kind this build does not know
 *  fails the caller's check rather than crashing the parse. */
export interface ParsedSweepTriggerKey {
  kind: string;
  subjectKey: string;
}

/**
 * Inverse of `sweepTriggerKey` (#5751 W02, #5753). A sweep-condition fix watch
 * re-probes the SUBJECT its finding was about, and an intent's `trigger_key`
 * is the only durable record of that subject — so build and parse must round
 * trip, and `remediationTrigger.test.ts` asserts they do.
 *
 * Two shapes that look like edge cases and are not:
 *  - the subject may itself contain colons (a `disk_pressure` subject is a
 *    mount point — on Windows, `C:\`), so everything after the second
 *    separator is the subject. A plain `split(':')` would probe `C` instead.
 *  - `sweepTriggerKey(kind, '')` drops the empty part and yields a two-segment
 *    key. That is a finding with no identifiable subject; it returns null
 *    rather than a half-record, which could not be probed and which
 *    `ai_agent_fix_watches_subject_shape_chk` rejects anyway.
 */
export function parseSweepTriggerKey(key: string | null | undefined): ParsedSweepTriggerKey | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts.length < 3 || parts[0] !== 'sweep') return null;
  const kind = parts[1] ?? '';
  const subjectKey = parts.slice(2).join(':');
  if (!kind || !subjectKey) return null;
  return { kind, subjectKey };
}

export function alertTriggerKey(configItemName: string | null, ruleId: string | null): string {
  return configItemName?.trim()
    ? buildTriggerKey(['alert', configItemName, ''])
    : buildTriggerKey(['alert', ruleId ?? '']);
}
export function monitorTriggerKey(builtinKeyOrId: string): string {
  return buildTriggerKey(['monitor', builtinKeyOrId]);
}
