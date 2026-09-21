import { describe, expect, it } from 'vitest';
import { aiTools, getToolTier } from './aiTools';
import { TIER3_ACTIONS, checkGuardrails } from './aiGuardrails';

/**
 * Disk Cleanup v2 W05, spec §9.2 — the MCP contract for the three disk tools,
 * pinned where it can actually be asserted.
 *
 * `isToolWhollyGatedOverMcp` and `gatedActionsForTool` are module-private to
 * routes/mcpServer.ts, and `mcpServer.*.test.ts` mocks the tool registry — so
 * only here, against the REAL definitions, can the inputs those two functions
 * consume be compared with TIER3_ACTIONS. Same technique as
 * aiAgentSdkTools.mcpCoverage.test.ts's "manage_organizations is wholly gated
 * over MCP" block, and the same reason: the behaviour is asserted through the
 * real listing path there, the DATA behind it only here.
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry.
 */

function advertisedActions(tool: string): string[] | undefined {
  return (
    aiTools.get(tool)!.definition.input_schema.properties as { action?: { enum?: string[] } }
  ).action?.enum;
}

/**
 * The predicate routes/mcpServer.ts (isToolWhollyGatedOverMcp) applies, minus
 * its MCP_APPROVAL_REQUIRED_EXTRA_TOOLS short-circuit: that map is
 * module-private, names only collect_evidence, and is asserted through the
 * real listing path in mcpServer.approvalGate.test.ts.
 */
function whollyGatedOverMcp(tool: string): boolean {
  const baseTier = getToolTier(tool);
  if (baseTier === undefined) return false;
  if (baseTier >= 3) return true;
  const actions = advertisedActions(tool);
  if (!actions || actions.length === 0) return false;
  const tier3 = TIER3_ACTIONS[tool];
  if (!tier3 || tier3.length === 0) return false;
  return actions.every((action) => tier3.includes(action));
}

describe('§9.2 — the disk tools over MCP', () => {
  it('Tier 3 actions are a HARD DENY over MCP, not an approval flow', () => {
    // tools/call computes max(baseTier, guardrailTier) and answers
    // MCP_APPROVAL_REQUIRED before the scope gates, the production allowlist,
    // RBAC, the rate limit, the execution org and the ledger. So these two are
    // unreachable over MCP by construction — an MCP client diagnoses and hands
    // the destructive step to a tech in the web app.
    expect(Math.max(getToolTier('disk_cleanup')!, checkGuardrails('disk_cleanup', { action: 'execute' }).tier)).toBe(3);
    expect(Math.max(getToolTier('system_cleanup')!, checkGuardrails('system_cleanup', { action: 'run' }).tier)).toBe(3);
  });

  it('their read-only actions stay reachable over MCP', () => {
    expect(Math.max(getToolTier('disk_cleanup')!, checkGuardrails('disk_cleanup', { action: 'preview' }).tier)).toBe(1);
    expect(Math.max(getToolTier('system_cleanup')!, checkGuardrails('system_cleanup', { action: 'list' }).tier)).toBe(1);
    // `status` is a read of the run row: Tier 1, listed and callable over MCP.
    expect(Math.max(getToolTier('system_cleanup')!, checkGuardrails('system_cleanup', { action: 'status' }).tier)).toBe(1);
    expect(Math.max(getToolTier('analyze_disk_usage')!, checkGuardrails('analyze_disk_usage', {}).tier)).toBe(1);
  });

  it('both stay LISTED — they are mixed multiplexers, not wholly gated tools', () => {
    // A wholly-gated tool is suppressed from tools/list (the
    // advertised-but-dead pattern). These two must NOT be suppressed, or MCP
    // clients lose read-only disk diagnosis entirely.
    expect(advertisedActions('disk_cleanup')).toEqual(['preview', 'execute']);
    expect(advertisedActions('system_cleanup')).toEqual(['list', 'run', 'status']);
    expect(whollyGatedOverMcp('disk_cleanup')).toBe(false);
    expect(whollyGatedOverMcp('system_cleanup')).toBe(false);
    // analyze_disk_usage is not action-multiplexed at all, so it is never
    // gated and its listed description gains no note.
    expect(advertisedActions('analyze_disk_usage')).toBeUndefined();
    expect(whollyGatedOverMcp('analyze_disk_usage')).toBe(false);
  });

  it('only the destructive action carries the tools/list approval note', () => {
    expect(TIER3_ACTIONS.disk_cleanup).toEqual(['execute']);
    expect(TIER3_ACTIONS.system_cleanup).toEqual(['run']);
  });

  it('device-scoped org resolution is declared, so the ledger attributes to the DEVICE’s org', () => {
    // Amendment B1: omitting deviceArgs does NOT error — resolveMcpExecutionContext
    // falls through to the caller's first accessible org, which silently
    // misattributes the tool-execution ledger and the audit row. All three
    // declare it.
    for (const tool of ['analyze_disk_usage', 'disk_cleanup', 'system_cleanup']) {
      expect(aiTools.get(tool)!.deviceArgs, `${tool} must declare its device arg`).toEqual(['deviceId']);
    }
  });
});
