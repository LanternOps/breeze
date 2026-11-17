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
  'alerts',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/**
 * Parameter wording shared by the registry definition (`aiToolsExport.ts`) and
 * the SDK shape (`aiAgentSdkTools.ts`), which an analysis run's model reads.
 * The tool description is capped at 300 characters and the list of names fills
 * it, so the per-dataset rules live here (each ≤ 160, the parameter cap) and,
 * in full, in the notes each adapter adds to its result.
 */
export const EXPORT_DATASET_PARAM_DESCRIPTION =
  'Which dataset. Left-out rows and dedupe keys come back as notes in the result. service_checks: non-running only; per-device datasets may truncate.';
export const EXPORT_FILTERS_PARAM_DESCRIPTION =
  'As the read tool. timeRange {start,end} ISO on newer datasets: default 30 d, max 180 d, ignored by current state. patch_state status[]; change_log changeType[].';
