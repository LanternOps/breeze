/**
 * The `export_dataset` dataset names: the single list (W00 C8).
 *
 * A zero-import leaf on purpose. Both Zod enums (`aiToolSchemas.ts`,
 * `aiAgentSdkTools.ts`) derive from it, and the hub
 * (`aiToolsExportDatasets.ts`) reaches `aiTools` through `aiToolsFleet`, while
 * `aiTools.ts` imports `aiToolSchemas`. A value import from the hub into
 * `aiToolSchemas.ts` would close that cycle, and `z.enum(...)` evaluates at
 * module load (temporal dead zone). Keep this file free of imports.
 */
export const EXPORT_DATASETS = [
  'event_logs', 'agent_logs', 'device_inventory', 'software_inventory',
  'metrics', 'vulnerabilities', 'custom_fields',
  'reliability_scores',
  'reliability_history',
  'reliability_events',
  'boot_performance',
  'hardware_events',
  'service_checks',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/**
 * Parameter wording shared by the registry definition (`aiToolsExport.ts`) and
 * the SDK shape (`aiAgentSdkTools.ts`), which an analysis run's model reads.
 * The tool description is capped at 300 characters and the list of names fills
 * it, so the per-dataset rules live here (each ≤ 160, the parameter cap).
 */
export const EXPORT_DATASET_PARAM_DESCRIPTION =
  'Which dataset. service_checks lists non-running checks only; reliability_events can repeat an event (dedupe on eventKey); per-device datasets may truncate.';
export const EXPORT_FILTERS_PARAM_DESCRIPTION =
  'As the read tool. timeRange {start,end} ISO for reliability/boot/hardware/service: default 30 days, max 180 days. reliability_scores is current state.';
