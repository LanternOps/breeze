import { describe, expect, it } from 'vitest';
import { TIER1_READ_ACTIONS, TIER2_ACTIONS, TIER3_ACTIONS } from './aiGuardrails';
import { isMfaGatedToolAction } from './aiToolMfaGate';
import { AGENT_HUMAN_ONLY_ACTIONS } from './aiToolExposure';
import { MANUAL_ASSET_TYPES, POSTURE_CATEGORIES, deviceOpsToolSchemas } from './aiToolSchemasDeviceOps';
import { MANAGEMENT_POSTURE_CATEGORIES } from '../routes/agents/schemas';
import { discoveredAssetTypeEnum } from '../db/schema';

/**
 * Full-control W13 (#6783, PR A): every W13 write is MFA-gated (W13-D6, REST
 * `requireMfa()` parity) and no read is; every non-read action is classified.
 */
const W13 = Object.keys(deviceOpsToolSchemas);

function actionsOf(tool: string): string[] | undefined {
  const action = ((deviceOpsToolSchemas[tool] as unknown as { shape: Record<string, unknown> }).shape).action as
    { options?: readonly string[] } | undefined;
  return action?.options ? [...action.options] : undefined;
}

describe('W13 MFA gate covers every write and no read (#6783)', () => {
  it.each(W13)('%s', (tool) => {
    const actions = actionsOf(tool);
    if (!actions) {
      // The four single-purpose tools are reads.
      expect(isMfaGatedToolAction(tool, undefined), tool).toBe(false);
      return;
    }
    const reads = new Set(TIER1_READ_ACTIONS[tool] ?? []);
    for (const action of actions) {
      expect(isMfaGatedToolAction(tool, action), `${tool}:${action}`).toBe(!reads.has(action));
    }
  });

  it('every non-read W13 action is classified tier 2 or tier 3', () => {
    for (const tool of W13) {
      const actions = actionsOf(tool) ?? [];
      const reads = new Set(TIER1_READ_ACTIONS[tool] ?? []);
      for (const action of actions.filter((a) => !reads.has(a))) {
        const classified = (TIER2_ACTIONS[tool] ?? []).includes(action) || (TIER3_ACTIONS[tool] ?? []).includes(action);
        expect(classified, `${tool}:${action}`).toBe(true);
      }
    }
  });

  it('manage_device_function:set is agent-human-only (W13 plan fact 1)', () => {
    expect(AGENT_HUMAN_ONLY_ACTIONS.has('manage_device_function:set')).toBe(true);
    expect(AGENT_HUMAN_ONLY_ACTIONS.has('manage_device_function:get')).toBe(false);
  });
});

describe('W13 schema constants', () => {
  it('MANUAL_ASSET_TYPES equals the discovered_asset_type pg enum', () => {
    expect([...MANUAL_ASSET_TYPES]).toEqual([...discoveredAssetTypeEnum.enumValues]);
  });

  it('POSTURE_CATEGORIES equals the agent schema MANAGEMENT_POSTURE_CATEGORIES', () => {
    expect([...POSTURE_CATEGORIES]).toEqual([...MANAGEMENT_POSTURE_CATEGORIES]);
  });
});
