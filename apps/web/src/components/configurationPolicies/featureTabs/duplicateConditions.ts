import type { FeatureLink } from './types';

// duplicateConditions.ts
// Pure, client-side detection of "this policy alerts twice for one condition":
// an attached, enabled monitor of kind K next to an inline alert rule whose
// condition maps to K, or a service/process watch with the same name as a
// service/process monitor. Transitional (W05a → W05c): the conversion panel
// replaces it.

export interface DuplicateHit {
  monitorId: string;
  monitorName: string;
  legacyLabel: string;
  source: 'alert_rule' | 'monitoring';
}

export interface DuplicateInput {
  attached: Array<{ monitorId: string; enabled?: boolean }>;
  catalog: Array<{ id: string; name: string; kind: string; condition?: Record<string, unknown> | null }>;
  inlineRules: Array<{ name?: string; conditions?: Array<Record<string, unknown>> | null }>;
  watches: Array<{ watchType?: string; name?: string; enabled?: boolean }>;
}

/** Advisory-only cumulative attachments: the entire own entry wins per monitor. */
export function effectiveAttachedMonitors(
  ownLink: FeatureLink | undefined,
  parentLink: FeatureLink | undefined,
): DuplicateInput['attached'] {
  const items = (link: FeatureLink | undefined) =>
    (link?.inlineSettings?.items as DuplicateInput['attached'] | undefined) ?? [];
  return [...new Map(
    [...items(parentLink), ...items(ownLink)].map((item) => [item.monitorId, item]),
  ).values()];
}

// Mirrors apps/api/src/services/alertConditions/utils.ts METRIC_NAME_MAP (line 13), minus
// processCount/processes (no monitor kind exists for them).
const METRIC_TO_KIND: Record<string, string> = {
  cpu: 'cpu', cpuPercent: 'cpu',
  ram: 'memory', ramPercent: 'memory', memory: 'memory',
  disk: 'disk', diskPercent: 'disk',
};

function kindOfInlineCondition(c: Record<string, unknown>): string | null {
  const type = typeof c.type === 'string' ? c.type : '';
  if (type === 'metric' || type === 'threshold') {
    const metric = typeof c.metric === 'string' ? c.metric : '';
    return METRIC_TO_KIND[metric] ?? null;
  }
  if (type === 'offline' || type === 'status') return 'offline';
  if (type === 'event_log') return 'event_log';
  return null;
}

export function findDuplicateConditions(input: DuplicateInput): DuplicateHit[] {
  const byId = new Map(input.catalog.map((c) => [c.id, c]));
  const active = input.attached
    .filter((a) => a.enabled !== false)
    .map((a) => byId.get(a.monitorId))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const hits: DuplicateHit[] = [];
  const seen = new Set<string>();
  const push = (hit: DuplicateHit) => {
    const key = `${hit.source}:${hit.legacyLabel}:${hit.monitorId}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const rule of input.inlineRules) {
    const label = rule.name?.trim() || 'Alert rule';
    for (const cond of rule.conditions ?? []) {
      const kind = kindOfInlineCondition(cond);
      if (!kind) continue;
      for (const m of active) {
        if (m.kind === kind) push({ monitorId: m.id, monitorName: m.name, legacyLabel: label, source: 'alert_rule' });
      }
    }
  }

  for (const w of input.watches) {
    if (w.enabled === false) continue;
    const wt = w.watchType === 'service' || w.watchType === 'process' ? w.watchType : null;
    const name = w.name?.trim().toLowerCase();
    if (!wt || !name) continue;
    for (const m of active) {
      if (m.kind !== wt) continue;
      const target = wt === 'service' ? m.condition?.serviceName : m.condition?.processName;
      if (typeof target === 'string' && target.trim().toLowerCase() === name) {
        push({ monitorId: m.id, monitorName: m.name, legacyLabel: w.name!.trim(), source: 'monitoring' });
      }
    }
  }
  return hits;
}
