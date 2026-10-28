import { describe, expect, it } from 'vitest';

import { getAllRegisteredToolNames, getToolTier } from './aiTools';
import { TIER1_ACTIONS, TIER2_ACTIONS } from './aiGuardrails';

/**
 * #10027 contract: with MCP_TIER3_INTENTS_ENABLED on, MCP `tools/call` runs an
 * action that checkGuardrails rates below Tier 3 directly, even on a tool
 * whose registry tier is 3 (createActionIntent would refuse to file it as an
 * approval intent: tool_not_tier3). This pins the full set of such actions
 * on the real registry, so adding a TIER1/TIER2_ACTIONS entry to a Tier-3
 * tool is a reviewed decision about MCP approval, not a side effect.
 *
 * Every entry is a read except edr_endpoint_action:scan (starts an EDR scan;
 * Tier 2 by #8167). Before adding a non-read here, confirm it should run over
 * MCP with no approval when the flag is on.
 */
const EXPECTED: Record<string, string[]> = {
  edr_endpoint_action: ['scan'],
  execute_command: ['event_logs_list', 'file_list', 'list_processes'],
  manage_browser_policy: ['list'],
  manage_services: ['list'],
  manage_software_policy: ['get', 'list'],
  security_scan: ['vulnerabilities'],
  send_endpoint_message: ['get', 'list'],
};

describe('actions rated below Tier 3 on a registry-Tier-3 tool (#10027)', () => {
  it('is exactly the reviewed set', () => {
    const actual: Record<string, string[]> = {};
    for (const name of getAllRegisteredToolNames()) {
      if (getToolTier(name) !== 3) continue;
      const below = [...(TIER1_ACTIONS[name] ?? []), ...(TIER2_ACTIONS[name] ?? [])];
      if (below.length > 0) actual[name] = [...new Set(below)].sort();
    }
    expect(actual).toEqual(EXPECTED);
  });

  it('no registry-Tier-4 tool has a below-Tier-3 action entry', () => {
    const tier4WithDowngrades = getAllRegisteredToolNames().filter((name) => (
      (getToolTier(name) ?? 0) >= 4 && ((TIER1_ACTIONS[name]?.length ?? 0) + (TIER2_ACTIONS[name]?.length ?? 0)) > 0
    ));
    expect(tier4WithDowngrades).toEqual([]);
  });
});
