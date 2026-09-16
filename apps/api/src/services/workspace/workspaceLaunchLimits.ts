/**
 * Execution plane W05 — `workspace_launch_analysis`'s name, tier table and
 * input bounds, as a ZERO-IMPORT leaf.
 *
 * Same reason as `workspaceToolNames.ts` next door: three registries need these
 * values (`aiTools.ts` for the tier, `aiToolSchemas.ts` for the Zod mirror,
 * `aiAgentSdkTools.ts` for the MCP `tool()` declaration), and importing them
 * from `workspaceLaunchTool.ts` would drag that module's whole runtime graph —
 * the artifact service, W04's admission path, the streaming session manager and
 * the chat run bridge — into every one of them. A schema map has no business
 * pulling in a Redis subscriber.
 *
 * The three caps live HERE, in one place, so the MCP declaration and the
 * central validator cannot drift: a mismatch would mean the SDK accepts an
 * input `validateToolInput` then rejects.
 */
export const WORKSPACE_LAUNCH_TOOL_NAME = 'workspace_launch_analysis';

export const WORKSPACE_LAUNCH_MAX_GOAL_CHARS = 2000;
export const WORKSPACE_LAUNCH_MAX_INPUT_HANDLES = 20;
export const WORKSPACE_LAUNCH_MAX_INPUT_DEVICES = 200;

/**
 * Tier table — this tool's ONLY presence in `aiTools.ts`. Same shape and same
 * reason as `m365ToolTiers` (`aiToolsM365.ts`): a session-only tool never enters
 * the `aiTools` execution map, but `getToolTier` must still answer for it or
 * `checkGuardrails` sees `tier === undefined` and refuses it as unknown.
 *
 * Tier 1 because it executes nothing on the fleet — it queues work whose every
 * fleet-touching step goes back through the tier gate, intents and approvals.
 */
export const workspaceLaunchToolTiers: Record<string, 1 | 3> = {
  [WORKSPACE_LAUNCH_TOOL_NAME]: 1,
};
