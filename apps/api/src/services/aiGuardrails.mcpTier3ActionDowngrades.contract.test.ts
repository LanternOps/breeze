import { describe, expect, it } from 'vitest';

import { getAllRegisteredToolNames, getToolTier } from './aiTools';
import {
  checkGuardrails,
  isReadOnlyResolution,
  needsRegistryTier3Approval,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';

/**
 * #10027 contract: with MCP_TIER3_INTENTS_ENABLED on, MCP `tools/call` runs an
 * action that checkGuardrails rates below Tier 3 on a registry-Tier-3 tool
 * directly ONLY when the action is read-only (`isReadOnlyResolution`). Every
 * other below-Tier-3 action on such a tool is filed for approval at the
 * tool's Tier 3 (`needsRegistryTier3Approval`).
 *
 * This pins both sets on the real registry and the real classifier, so adding
 * a TIER1/TIER2_ACTIONS entry to a Tier-3 tool is a reviewed decision about
 * MCP approval, not a side effect. A new Tier-2 action lands in
 * APPROVAL_REQUIRED by default; it is only lifted once it is also listed in
 * TIER2_READONLY_ACTIONS (whose own contract requires a pure read). A Tier-1
 * entry counts as read-only (the same rule headless agents use), so check
 * that a new TIER1_ACTIONS entry on a Tier-3 tool really is a pure read.
 */
const RUN_DIRECTLY: Record<string, string[]> = {
  execute_command: ['event_logs_list', 'file_list', 'list_processes'],
  manage_browser_policy: ['list'],
  manage_services: ['list'],
  manage_software_policy: ['get', 'list'],
  security_scan: ['vulnerabilities'],
  send_endpoint_message: ['get', 'list'],
};
// Not a read: starts an EDR scan on the endpoint (Tier 2 by #8167).
const APPROVAL_REQUIRED: Record<string, string[]> = {
  edr_endpoint_action: ['scan'],
};

function classify(toolName: string, action: string) {
  return checkGuardrails(toolName, { [TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action']: action });
}

describe('actions rated below Tier 3 on a registry-Tier-3 tool (#10027)', () => {
  it('splits exactly into the reviewed read-only and approval-required sets', () => {
    const readOnly: Record<string, string[]> = {};
    const approval: Record<string, string[]> = {};
    for (const name of getAllRegisteredToolNames()) {
      if (getToolTier(name) !== 3) continue;
      const below = [...new Set([...(TIER1_ACTIONS[name] ?? []), ...(TIER2_ACTIONS[name] ?? [])])].sort();
      for (const action of below) {
        const check = classify(name, action);
        expect(check.tier, `${name}:${action}`).toBeLessThan(3);
        const bucket = isReadOnlyResolution(name, check) ? readOnly : approval;
        (bucket[name] ??= []).push(action);
        expect(needsRegistryTier3Approval(name, check), `${name}:${action}`).toBe(bucket === approval);
      }
    }
    expect(readOnly).toEqual(RUN_DIRECTLY);
    expect(approval).toEqual(APPROVAL_REQUIRED);
  });

  it('never asks for registry-Tier-3 approval on a tool whose registry tier is not 3', () => {
    const offenders: string[] = [];
    for (const name of getAllRegisteredToolNames()) {
      if (getToolTier(name) === 3) continue;
      for (const action of [...(TIER1_ACTIONS[name] ?? []), ...(TIER2_ACTIONS[name] ?? [])]) {
        if (needsRegistryTier3Approval(name, classify(name, action))) offenders.push(`${name}:${action}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no registry-Tier-4 tool has a below-Tier-3 action entry', () => {
    const tier4WithDowngrades = getAllRegisteredToolNames().filter((name) => (
      (getToolTier(name) ?? 0) >= 4 && ((TIER1_ACTIONS[name]?.length ?? 0) + (TIER2_ACTIONS[name]?.length ?? 0)) > 0
    ));
    expect(tier4WithDowngrades).toEqual([]);
  });
});
