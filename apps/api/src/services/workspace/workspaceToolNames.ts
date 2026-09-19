/**
 * Execution plane W04 — the four workspace tool names, as a ZERO-IMPORT leaf.
 *
 * `aiGuardrails.ts` re-exports these (that is where the classification they
 * drive lives), but it also eagerly imports the whole `aiTools` registry, so
 * importing the names FROM it drags the registry into every consumer's module
 * graph. `analysisProfile.ts` and `runService.ts` need only the names, and
 * pulling the registry in behind them broke a couple of dozen suites' partial
 * module mocks and pushed socket-local route modules into the sweep
 * scheduler's worker closure. Import the names from here; import the
 * classification (`TIER1_NON_READONLY_TOOLS`, `isReadOnlyResolution`) from
 * `aiGuardrails.ts`.
 */
export const WORKSPACE_TOOL_NAMES = [
  'workspace_stage', 'workspace_run', 'workspace_collect', 'workspace_cancel',
] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
