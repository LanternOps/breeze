/**
 * W5 PR C (#5220), Task C4 — flows as tools on Breeze's MCP server (plan
 * Decision 8). `routes/mcpServer.ts` dispatches `flow__<slug>` here
 * EXPLICITLY, before its tenant-tool branch (`isTenantToolName('flow__x')` is
 * true: the name parses as tenant slug `flow`).
 *
 *  - `tools/list` advertises a flow tool only when it is callable right now:
 *    Tier 1 for `ai:read`, Tier 2 with `ai:write`, Tier 3 NEVER — this
 *    transport has no approval surface (the tenant-tool rule, #6401).
 *  - `tools/call` resolves the flow LIVE: a flow listed at Tier 2 that was
 *    re-enabled with a Tier-3 step is refused approval-required at call time.
 *    `MCP_UNATTENDED_TIER3_PRINCIPALS` is never honoured for flow tools (as
 *    for tenant tools). `run_flow` stays chat-only; MCP reaches flows only
 *    through `flow__<slug>`.
 *  - the run starts as the API key (its scopes ∩ its creator, W04 deviation
 *    2) through `startToolRun`, which re-proves rule 7 against the live
 *    publication. Flag off ⇒ nothing listed, every call `unknown`.
 *
 * Flow tools are dynamic: they never enter the static registry, so the MCP
 * registry count (`MCP_TOOL_COUNT_APPROX`) is unchanged by any of them.
 */
import { flowsEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { isFlowToolName } from './toolNames';

export interface McpFlowToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: 1 | 2;
}

export type McpFlowToolCallOutcome =
  | { kind: 'unknown' }
  | { kind: 'approval_required'; tier: 3 }
  | { kind: 'scope_required'; tier: 2; scope: 'ai:write' }
  | { kind: 'result'; tier: 1 | 2; isError: boolean; text: string };

export async function listMcpFlowTools(
  auth: AuthContext,
  orgId: string | null,
  opts: { hasWrite: boolean },
): Promise<McpFlowToolEntry[]> {
  if (!flowsEnabled()) return [];
  const { resolveFlowTools } = await import('./flowTools');
  const out: McpFlowToolEntry[] = [];
  for (const d of await resolveFlowTools(auth, orgId)) {
    if (d.tier === 3 || (d.tier === 2 && !opts.hasWrite)) continue;
    out.push({ name: d.name, description: d.definition.description, inputSchema: d.definition.input_schema, tier: d.tier });
  }
  return out;
}

/**
 * Resolve and start one MCP flow-tool call. The caller (mcpServer) has
 * applied the domain grant; it maps the outcome to JSON-RPC and applies the
 * RBAC and rate-limit checks for a `result`-bound call through
 * `beforeStart`, which runs after the tier and scope gates and before any
 * run exists (a string return refuses the call with that message).
 */
export async function callMcpFlowTool(
  name: string,
  input: Record<string, unknown>,
  auth: AuthContext,
  scopes: readonly string[],
  orgId: string | null,
  beforeStart?: (tier: 1 | 2) => Promise<string | null>,
): Promise<McpFlowToolCallOutcome | { kind: 'refused'; tier: 1 | 2; message: string }> {
  if (!flowsEnabled() || !isFlowToolName(name)) return { kind: 'unknown' };
  const { resolveFlowToolForCall } = await import('./flowTools');
  const d = await resolveFlowToolForCall(auth, name, orgId);
  if (!d) return { kind: 'unknown' };
  if (d.tier === 3) return { kind: 'approval_required', tier: 3 };
  const hasWrite = scopes.includes('ai:write') || scopes.includes('ai:execute');
  if (d.tier === 2 && !hasWrite) return { kind: 'scope_required', tier: 2, scope: 'ai:write' };
  const tier = d.tier;
  if (beforeStart) {
    const refusal = await beforeStart(tier);
    if (refusal) return { kind: 'refused', tier, message: refusal };
  }
  const { startToolRun } = await import('./toolRuns');
  const started = await startToolRun(d, input, 'mcp', { kind: 'api_key', auth }, { defaultOrgId: orgId });
  const payload = started.ok ? { runId: started.runId, runPath: started.runPath, duplicate: started.duplicate } : started;
  return { kind: 'result', tier, isError: !started.ok, text: JSON.stringify(payload) };
}
