import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_TIERS, createBreezeMcpServer } from '../aiAgentSdkTools';
import { TOOL_CAPABILITY } from '../aiAgents/agentToolCatalog';
import { AGENT_HUMAN_ONLY_TOOLS, TOOL_PERMISSIONS } from '../aiGuardrails';
import { toolInputSchemas } from '../aiToolSchemas';
import { aiTools, getAllRegisteredToolNames, getToolTier, requiresLiveSession } from '../aiTools';
import { hasCoreAiToolName } from '../aiToolNames';
import { WORKSPACE_LAUNCH_TOOL_NAME } from './workspaceLaunchLimits';

const SDK_TOOLS_SOURCE = readFileSync(join(__dirname, '..', 'aiAgentSdkTools.ts'), 'utf8');

/**
 * #6086 — chat-initiated background launches are WITHDRAWN, not merely
 * refused: a chat launch would run a background agent under a delegated
 * authorization this codebase cannot yet preserve for the length of a run.
 *
 * A half-deregistered tool is worse than either end state. While the name kept
 * a tier but had no `aiTools` entry, `requiresLiveSession()` reported TRUE,
 * so the durable intent-release worker would have answered a stale intent with
 * `session_required` — "retry me from a chat session" — instead of a terminal
 * refusal. (No such intent can exist: the name was Tier 1, and only tier >= 2
 * tools mint durable intents. That is why there is nothing left to keep the
 * stub alive for.) These assertions pin the name as absent from EVERY
 * registration surface; the only survivors are the reserved name itself and
 * the goal cap, which `runnerPrompt.ts` still uses to truncate a recorded goal.
 */
describe('workspace_launch_analysis is fully deregistered (#6086)', () => {
  it('is not an executable tool and not a reserved name', () => {
    expect(aiTools.has(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(false);
    expect(hasCoreAiToolName(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(false);
    expect(getAllRegisteredToolNames()).not.toContain(WORKSPACE_LAUNCH_TOOL_NAME);
  });

  it('resolves no tier, so checkAgentGuardrails refuses it as an unknown tool', () => {
    expect(getToolTier(WORKSPACE_LAUNCH_TOOL_NAME)).toBeUndefined();
    expect(TOOL_TIERS[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
  });

  it('does NOT report session_required — a stale intent gets a terminal unknown-tool failure', () => {
    expect(requiresLiveSession(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(false);
  });

  it('is absent from TOOL_CAPABILITY, the headless agent surface', () => {
    expect(TOOL_CAPABILITY[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
  });

  it('is absent from the MCP tool registry while the workspace worker tools remain', () => {
    const server = createBreezeMcpServer(() => ({}) as never);
    const instance = server.instance as unknown as { _registeredTools: Record<string, unknown> };
    expect(instance._registeredTools[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
    expect(SDK_TOOLS_SOURCE).not.toContain(WORKSPACE_LAUNCH_TOOL_NAME);
    for (const name of ['workspace_stage', 'workspace_run', 'workspace_collect', 'workspace_cancel']) {
      expect(aiTools.has(name)).toBe(true);
    }
  });

  it('has no input schema and no RBAC mapping', () => {
    expect(toolInputSchemas[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
    expect(TOOL_PERMISSIONS[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
  });

  it('stays in AGENT_HUMAN_ONLY_TOOLS — an unconditional deny outranks an unknown-tool error', () => {
    // Belt and braces, and the thing that must survive a re-registration: if
    // the name is ever wired up again, `checkAgentGuardrails` denies it for an
    // `ai_agent` principal ABOVE the allowlist, before any tier resolution.
    expect(AGENT_HUMAN_ONLY_TOOLS.has(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(true);
  });

  it('has no handler module left to call', () => {
    // The refusal stub had no importer outside its own test. A dead handler
    // that still parses is how a withdrawn tool gets quietly re-wired.
    expect(existsSync(join(__dirname, 'workspaceLaunchTool.ts'))).toBe(false);
    const limitsSource = readFileSync(join(__dirname, 'workspaceLaunchLimits.ts'), 'utf8');
    expect(limitsSource).not.toContain('workspaceLaunchToolTiers');
  });

  it('puts no identity field on ToolExecutionContext', () => {
    // The withdrawn R4 design threaded the chat session through
    // `ToolExecutionContext.chatSessionId`. That type's docstring reserves it
    // for per-invocation EXECUTION INPUTS, explicitly not caller identity; a
    // session id is identity. The grep is the contract — the alternative compiles.
    const contextSource = readFileSync(join(__dirname, '..', 'toolExecutionContext.ts'), 'utf8');
    expect(contextSource).not.toContain('chatSessionId');
  });
});
