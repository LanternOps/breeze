/**
 * Reserved chat-launch metadata for historical records and schema validation.
 * Chat launches and MCP exposure are disabled pending delegated authorization
 * design (#6086); retaining this name does not enable execution.
 */
export const WORKSPACE_LAUNCH_TOOL_NAME = 'workspace_launch_analysis';

export const WORKSPACE_LAUNCH_MAX_GOAL_CHARS = 2000;
export const WORKSPACE_LAUNCH_MAX_INPUT_HANDLES = 20;
export const WORKSPACE_LAUNCH_MAX_INPUT_DEVICES = 200;

/** Compatibility tier for the reserved name; absent from the SDK chat allowlist. */
export const workspaceLaunchToolTiers: Record<string, 1 | 3> = {
  [WORKSPACE_LAUNCH_TOOL_NAME]: 1,
};
