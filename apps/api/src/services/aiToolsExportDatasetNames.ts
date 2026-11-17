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
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
