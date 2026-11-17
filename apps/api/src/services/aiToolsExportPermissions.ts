/**
 * Wisp analysis sessions W02 — the permission each `export_dataset` dataset
 * requires, and the evaluation that freezes an analysis run's export authority.
 *
 * Why this is a leaf with ZERO runtime imports: the chat launch gate, the
 * analysis task prompt and the `export_dataset` handler all load it, and the
 * handler side sits inside the `aiToolSchemas → aiTools → aiToolsExport →
 * aiToolsExportDatasets` load cycle. A value import here could close that
 * cycle and crash at module load. Both imports below are `import type` and are
 * erased at compile time (a source-text test pins this).
 *
 * Why these are HUMAN permissions evaluated at admission and not a handler-side
 * RBAC check: `export_dataset` only runs inside an agent run, and a run
 * principal (`ai_agent`) has no role — every RBAC check denies it outright.
 * So the Wisp launcher evaluates these requirements against the live grant
 * ceiling (the grantor's delegated permissions intersected with what they hold
 * now) when the run is admitted, freezes the result into
 * `staged_inputs.exportGrants`, and the handler checks only that frozen set.
 * A frozen grant can therefore never be wider than what the grantor could read
 * at that moment.
 */
import type { ExportDataset } from './aiToolsExportDatasets';
import type { AnalysisSensitiveGate, AiRunExportGrants } from '../db/schema/aiAgents';

export interface ExportPermission {
  resource: string;
  action: string;
}

export interface ExportDatasetRequirement {
  /** Read permission of the dataset's equivalent human read tool (`TOOL_PERMISSIONS`). */
  permission: ExportPermission;
  /** A class of rows inside the dataset that needs one more permission. Without
   *  it the rows are withheld and the result says so; the dataset still exports. */
  sensitiveGate?: { gate: AnalysisSensitiveGate; permission: ExportPermission };
}

const DEVICES_READ: ExportPermission = Object.freeze({ resource: 'devices', action: 'read' });
const DEVICES_EXECUTE: ExportPermission = Object.freeze({ resource: 'devices', action: 'execute' });

/**
 * One entry per `EXPORT_DATASETS` member, in its declaration order (a test pins
 * the key set). Every existing dataset maps to `devices:read`, the permission
 * every equivalent read tool declares; the `security` event-log category needs
 * `devices:execute`, the same gate `canReadSensitiveEventLogCategory` applies
 * to a human caller.
 */
export const EXPORT_DATASET_REQUIREMENTS: Readonly<Record<ExportDataset, ExportDatasetRequirement>> = Object.freeze({
  event_logs: Object.freeze({
    permission: DEVICES_READ,
    sensitiveGate: Object.freeze({ gate: 'security_events' as const, permission: DEVICES_EXECUTE }),
  }),
  agent_logs: Object.freeze({ permission: DEVICES_READ }),
  device_inventory: Object.freeze({ permission: DEVICES_READ }),
  software_inventory: Object.freeze({ permission: DEVICES_READ }),
  metrics: Object.freeze({ permission: DEVICES_READ }),
  vulnerabilities: Object.freeze({ permission: DEVICES_READ }),
  custom_fields: Object.freeze({ permission: DEVICES_READ }),
  reliability_scores: Object.freeze({ permission: DEVICES_READ }),
  reliability_history: Object.freeze({ permission: DEVICES_READ }),
});

/**
 * The export authority of a run admitted before W02 (its `staged_inputs` has
 * no `exportGrants`): the ORIGINAL SEVEN datasets, written out as a literal and
 * NEVER derived from `EXPORT_DATASETS` or this file's record (both grow in
 * W04/W05), and no sensitive gate. A pre-W02 run must never gain a dataset
 * added after it was admitted. Do not edit this list when adding datasets.
 */
export const LEGACY_EXPORT_GRANTS: Readonly<AiRunExportGrants> = Object.freeze({
  datasets: Object.freeze([
    'event_logs', 'agent_logs', 'device_inventory', 'software_inventory',
    'metrics', 'vulnerabilities', 'custom_fields',
  ]) as string[],
  sensitiveGates: Object.freeze([] as AnalysisSensitiveGate[]) as AnalysisSensitiveGate[],
});

/**
 * Evaluate every dataset's requirement against `has` (the caller's live grant
 * ceiling). A dataset is granted when `has` holds its permission. A sensitive
 * gate is held only when a GRANTED dataset declares it and `has` holds the
 * gate's permission — a gate for a dataset the run cannot export is never held.
 * `datasets` keeps declaration order; `sensitiveGates` is deduplicated and sorted.
 */
export function resolveExportGrants(has: (resource: string, action: string) => boolean): AiRunExportGrants {
  const datasets: string[] = [];
  const gates = new Set<AnalysisSensitiveGate>();
  for (const [dataset, req] of Object.entries(EXPORT_DATASET_REQUIREMENTS) as [ExportDataset, ExportDatasetRequirement][]) {
    if (!has(req.permission.resource, req.permission.action)) continue;
    datasets.push(dataset);
    const gate = req.sensitiveGate;
    if (gate && has(gate.permission.resource, gate.permission.action)) gates.add(gate.gate);
  }
  return { datasets, sensitiveGates: [...gates].sort() };
}

/**
 * The sensitive gates the named datasets declare that `grants` does not hold,
 * deduplicated and sorted. Names that are not datasets contribute nothing.
 */
export function withheldSensitiveGates(datasets: readonly string[], grants: AiRunExportGrants): AnalysisSensitiveGate[] {
  const held = new Set(grants.sensitiveGates);
  const withheld = new Set<AnalysisSensitiveGate>();
  for (const name of datasets) {
    if (!Object.prototype.hasOwnProperty.call(EXPORT_DATASET_REQUIREMENTS, name)) continue;
    const gate = EXPORT_DATASET_REQUIREMENTS[name as ExportDataset].sensitiveGate;
    if (gate && !held.has(gate.gate)) withheld.add(gate.gate);
  }
  return [...withheld].sort();
}

const KNOWN_GATES: ReadonlySet<string> = new Set<AnalysisSensitiveGate>(['security_events', 'user_account_changes']);

/**
 * The export authority a handler enforces for one call, from the run's frozen
 * `ToolExecutionContext.exportGrants`:
 * - absent (a run admitted before W02) → `LEGACY_EXPORT_GRANTS`;
 * - well-formed → a copy of it;
 * - present but malformed → NOTHING permitted. A corrupt frozen grant fails
 *   closed; it never falls back to the legacy set, which could be wider.
 */
export function effectiveExportGrants(value: unknown): AiRunExportGrants {
  if (value === undefined) return { datasets: [...LEGACY_EXPORT_GRANTS.datasets], sensitiveGates: [] };
  return frozenExportGrantsOf(value) ?? { datasets: [], sensitiveGates: [] };
}

/**
 * A recorded frozen grant, read strictly: a copy when well-formed, otherwise
 * null — including when absent. For callers that must PROVE what a run was
 * allowed (continuation carry-over), where neither the legacy set nor "nothing
 * permitted" is a safe stand-in for an unreadable value.
 */
export function frozenExportGrantsOf(value: unknown): AiRunExportGrants | null {
  const v = value as Partial<Record<keyof AiRunExportGrants, unknown>> | null | undefined;
  if (
    v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)
    || !Array.isArray(v.datasets) || !v.datasets.every((d) => typeof d === 'string')
    || !Array.isArray(v.sensitiveGates) || !v.sensitiveGates.every((g) => typeof g === 'string' && KNOWN_GATES.has(g))
  ) {
    return null;
  }
  return { datasets: [...(v.datasets as string[])], sensitiveGates: [...(v.sensitiveGates as AnalysisSensitiveGate[])] };
}
