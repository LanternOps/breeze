/**
 * Reserved chat-launch metadata. `workspace_launch_analysis` is FULLY
 * deregistered (#6086): no tier, no input schema, no handler and no MCP
 * declaration — chat-initiated background launches are withdrawn until a run
 * can preserve its caller's authorization. What survives is the reserved NAME,
 * so the deregistration contract (workspaceLaunchTool.registration.test.ts)
 * and the `AGENT_HUMAN_ONLY_TOOLS` deny can both refer to it without a string
 * literal, and the goal cap, which `aiAgents/runnerPrompt.ts` still applies
 * when it records an analysis goal.
 */
export const WORKSPACE_LAUNCH_TOOL_NAME = 'workspace_launch_analysis';

export const WORKSPACE_LAUNCH_MAX_GOAL_CHARS = 2000;
