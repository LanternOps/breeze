/**
 * Workspace-tool reachability pin (2026-09-17 AI tool ROLE audit §2.7).
 *
 * `workspace_stage` / `_run` / `_collect` / `_cancel` are mapped to flat
 * `ai_agents:read` in `TOOL_PERMISSIONS`, and `workspace_run` executes
 * arbitrary bash / python / node. `ai_agents:read` is a low-bar grant — the
 * seeded Org Admin already holds it — so that mapping is nowhere near
 * sufficient on its own.
 *
 * CORRECTION to the audit's premise, verified here: the four tools ARE on the
 * chat and MCP tool surface today (`getToolDefinitions()`, `TOOL_TIERS`, and
 * an `aiAgentSdkTools.ts` declaration each). What makes `ai_agents:read` safe
 * is NOT deregistration; it is `resolveWorkspace` in
 * `workspace/workspaceTools.ts`, which takes the run id from the CALLER
 * IDENTITY only (`auth.principal.kind === 'ai_agent'` + `runId`) and answers
 * every other principal with the typed `workspace_requires_run`. There is no
 * `runId` input on any of these tools, so nothing the model sends can reach
 * a workspace.
 *
 * That is the invariant this file pins. Re-enabling chat-initiated launch
 * (#6086) means handing a CHAT caller a run-bearing principal — at which point
 * `TOOL_PERMISSIONS` becomes the only remaining gate and `ai_agents:read` must
 * be raised to an execute-class permission first. The `principal denied`
 * assertions below are what will fail when that happens.
 */
import { describe, it, expect } from 'vitest';
import type { AiTool } from './aiTools';
import { getToolDefinitions, getAllRegisteredToolNames, getToolTier } from './aiTools';
import { registerWorkspaceTools } from './workspace/workspaceTools';
import { TOOL_PERMISSIONS, WORKSPACE_TOOL_NAMES, AGENT_HUMAN_ONLY_TOOLS } from './aiGuardrails';
import type { AuthContext } from '../middleware/auth';

const LAUNCH_TOOL = 'workspace_launch_analysis';

function workspaceHandlers(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerWorkspaceTools(map);
  return map;
}

const authWith = (principal: unknown): AuthContext =>
  ({
    user: { id: 'user-1' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    accessibleOrgIds: ['org-1'],
    principal,
  }) as unknown as AuthContext;

describe('workspace_* tools: what actually gates them', () => {
  it('they are on the chat / MCP tool surface — deregistration is NOT the control', () => {
    // Recorded deliberately. If this ever flips to "absent", the run-principal
    // assertions below stop being the thing that protects the mapping and this
    // file's reasoning needs rewriting rather than silently passing.
    const offered = getToolDefinitions().map((t) => t.name);
    for (const name of WORKSPACE_TOOL_NAMES) {
      expect(offered, `${name} is expected on the served tool list`).toContain(name);
      expect(getAllRegisteredToolNames()).toContain(name);
      expect(getToolTier(name)).toBe(1);
    }
  });

  it.each([...WORKSPACE_TOOL_NAMES])(
    '%s refuses a chat/MCP caller: no ai_agent principal => workspace_requires_run',
    async (name) => {
      const tool = workspaceHandlers().get(name)!;
      expect(tool, `${name} is no longer registered by registerWorkspaceTools`).toBeDefined();
      // A chat user carries no principal at all; an MCP key carries a non-agent one.
      for (const principal of [undefined, { kind: 'user' }, { kind: 'ai_agent' }]) {
        const raw = await tool.handler(authWith(principal) as never, { command: 'echo hi', files: [] } as never);
        // Exact envelope, not a substring: the handler must have taken the
        // typed refusal branch, not merely mentioned the code somewhere.
        expect(JSON.parse(String(raw)).error, `${name} admitted principal ${JSON.stringify(principal)}`).toBe(
          'workspace_requires_run',
        );
      }
    },
  );

  it('their TOOL_PERMISSIONS mapping is still the low-bar ai_agents:read this note is about', () => {
    for (const name of WORKSPACE_TOOL_NAMES) {
      expect(TOOL_PERMISSIONS[name], `${name} lost its TOOL_PERMISSIONS entry`).toEqual({
        resource: 'ai_agents',
        action: 'read',
      });
    }
  });

  it('workspace_launch_analysis stays deregistered and unconditionally denied to agents', () => {
    expect(getToolDefinitions().map((t) => t.name)).not.toContain(LAUNCH_TOOL);
    expect(getAllRegisteredToolNames()).not.toContain(LAUNCH_TOOL);
    expect(AGENT_HUMAN_ONLY_TOOLS.has(LAUNCH_TOOL)).toBe(true);
  });
});
