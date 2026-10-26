/**
 * W5 PR C (#5220), Task C3 — flows as CHAT tools: the Agent SDK tools a chat
 * session exposes (up to `flowToolsPerSessionMax` `flow__<slug>` tools,
 * resolved at session creation by `resolveFlowTools`, registered as
 * `extraTools` beside the tenant tools). Every call is gated first by
 * `flowToolGate.ts` (via `createSessionPreToolUse`).
 *
 * The handler starts the run on the descriptor the gate resolved, read from
 * the call's gate context (`extraToolCallContext`) — never on a re-resolution
 * the gate did not see. Reached without a gate context, it refuses.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkTool } from '../aiAgents/outcomeTools';
import { extraToolCallContext } from '../aiAgentSdkTools';
import { zodShapeFromJsonSchema } from '../toolSources/sdkBridge';
// Types only at module level: the resolver and the run service are loaded on
// first use, so the chat session manager (which imports this module) does not
// pull the flow runner's import graph into every chat code path and test.
import type { FlowToolDescriptor } from './flowTools';
import type { FlowToolSessionView } from './flowToolGate';

function textResult(payload: unknown, isError: boolean) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

/**
 * One SDK tool per descriptor (`[Flow] …`). The handler is hook-free:
 * `wrapExtraToolWithHooks` runs the pre/post hooks around it.
 */
export function buildFlowSdkTools(descriptors: FlowToolDescriptor[], getSession: () => FlowToolSessionView): SdkTool[] {
  return descriptors.map((d) =>
    tool(
      d.name,
      `[Flow] ${d.definition.description}`,
      zodShapeFromJsonSchema(d.definition.input_schema),
      async (args: Record<string, unknown>, extra: unknown) => {
        const gate = extraToolCallContext(extra)?.flowToolGate;
        if (!gate || gate.descriptor.name !== d.name) {
          return textResult({ error: 'flow_tool_unavailable', message: 'This flow call was not verified; nothing was started.' }, true);
        }
        const session = getSession();
        const { startToolRun } = await import('./toolRuns');
        const started = await startToolRun(gate.descriptor, args, 'ai_tool', { kind: 'user', auth: session.toolAuth }, {
          aiSessionId: session.breezeSessionId,
          defaultOrgId: session.orgId,
        });
        if (started.ok) return textResult({ runId: started.runId, runPath: started.runPath, duplicate: started.duplicate }, false);
        return textResult(started, true);
      },
    ) as SdkTool,
  );
}

/** `allowedTools` entries for a session's flow tools (same prefix as the core registry). */
export function flowMcpToolNames(descriptors: FlowToolDescriptor[]): string[] {
  return descriptors.map((d) => `mcp__breeze__${d.name}`);
}
