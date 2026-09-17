import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_TIERS, createBreezeMcpServer } from '../aiAgentSdkTools';
import { TOOL_CAPABILITY } from '../aiAgents/agentToolCatalog';
import { AGENT_HUMAN_ONLY_TOOLS, TOOL_PERMISSIONS } from '../aiGuardrails';
import { toolInputSchemas } from '../aiToolSchemas';
import { aiTools, getAllRegisteredToolNames, getToolTier, requiresLiveSession } from '../aiTools';
import { hasCoreAiToolName } from '../aiToolNames';
import { WORKSPACE_LAUNCH_TOOL_NAME } from './workspaceLaunchTool';

const SDK_TOOLS_SOURCE = readFileSync(join(__dirname, '..', 'aiAgentSdkTools.ts'), 'utf8');

describe('workspace_launch_analysis registration (spec §5.3, §5.5)', () => {
  it('is a RESERVED name and a recognized tool, but NOT in the aiTools execution map', () => {
    // The session-only shape, mirroring m365_lookup_user. A map entry would
    // make it headless-executable with no chat session — precisely what the
    // session-aware registration exists to prevent.
    expect(aiTools.has(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(false);
    expect(hasCoreAiToolName(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(true);
    expect(getAllRegisteredToolNames()).toContain(WORKSPACE_LAUNCH_TOOL_NAME);
  });

  it('resolves a tier through getToolTier — otherwise checkGuardrails refuses it as unknown', () => {
    expect(getToolTier(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(1);
  });

  it('requires a live session, so a durable release answers session_required not Unknown tool', () => {
    expect(requiresLiveSession(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(true);
  });

  it('is absent from the SDK chat allowlist', () => {
    expect(TOOL_TIERS[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
  });

  it('is NOT in TOOL_CAPABILITY — that map is the headless agent surface, and this tool is not on it', () => {
    // The W05 plan called for a `workspace` entry here, but the shipped
    // `agentToolCatalog.contract.test.ts` asserts `Object.keys(TOOL_CAPABILITY)`
    // EQUALS `[...aiTools.keys()]` — the headless execution map. A session-only
    // tool is not in that map, so an entry would break the contract for every
    // tool. That is the right answer and not a gap: TOOL_CAPABILITY exists to
    // compute which tools an `ai_agent` principal can reach, and this tool is
    // in AGENT_HUMAN_ONLY_TOOLS precisely so that it can reach none. Every
    // session-only tool already sits outside it — `m365_lookup_user` included.
    expect(TOOL_CAPABILITY[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
    expect(TOOL_CAPABILITY.m365_lookup_user).toBeUndefined();
  });

  it('is absent from the actual MCP tool registry while worker tools remain', () => {
    const server = createBreezeMcpServer(() => ({}) as never);
    const instance = server.instance as unknown as { _registeredTools: Record<string, unknown> };
    expect(instance._registeredTools[WORKSPACE_LAUNCH_TOOL_NAME]).toBeUndefined();
    expect(SDK_TOOLS_SOURCE).not.toContain(`makeSessionAwareHandler('${WORKSPACE_LAUNCH_TOOL_NAME}'`);
    for (const name of ['workspace_stage', 'workspace_run', 'workspace_collect', 'workspace_cancel']) {
      expect(aiTools.has(name)).toBe(true);
    }
  });

  it('has an input schema — without one, every call fails validation', () => {
    expect(toolInputSchemas[WORKSPACE_LAUNCH_TOOL_NAME]).toBeDefined();
    const parsed = toolInputSchemas[WORKSPACE_LAUNCH_TOOL_NAME]!.safeParse({
      goal: 'find failed logons',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a goal longer than the documented cap', () => {
    const parsed = toolInputSchemas[WORKSPACE_LAUNCH_TOOL_NAME]!.safeParse({
      goal: 'x'.repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });

  it('has an RBAC mapping', () => {
    expect(TOOL_PERMISSIONS[WORKSPACE_LAUNCH_TOOL_NAME]).toEqual({
      resource: 'ai_agents',
      action: 'write',
    });
  });

  it('is human-only — an ai_agent principal may never spawn a run', () => {
    expect(AGENT_HUMAN_ONLY_TOOLS.has(WORKSPACE_LAUNCH_TOOL_NAME)).toBe(true);
  });

  it('puts no identity field on ToolExecutionContext and reads no capture scope', () => {
    // The withdrawn R4 design threaded the chat session through
    // `ToolExecutionContext.chatSessionId` and W01's capture scope. That type's
    // docstring reserves it for per-invocation EXECUTION INPUTS, explicitly not
    // caller identity; a session id is identity. This asserts the design stayed
    // withdrawn — the grep is the contract, because the alternative compiles.
    const contextSource = readFileSync(join(__dirname, '..', 'toolExecutionContext.ts'), 'utf8');
    expect(contextSource).not.toContain('chatSessionId');
    const toolSource = readFileSync(join(__dirname, 'workspaceLaunchTool.ts'), 'utf8');
    expect(toolSource).not.toContain('captureScopeFor');
    expect(toolSource).not.toContain('CaptureScope');
    expect(toolSource).not.toContain('chatSessionId');
  });
});
