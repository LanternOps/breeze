import { describe, expect, it } from 'vitest';
import {
  TIER3_INPUT_AWARE_TOOLS,
  TIER_DECIDING_INPUT_KEYS,
  TOOL_ACTION_INPUT_KEYS,
  tierDecidingInputKeys,
} from './aiGuardrails';
import { LIVE_READ_INPUT_FLAGS } from './aiLiveDeviceReads';

/**
 * Tool Catalog W03 (#5218). A flow step's tier is computed at save time from
 * its literal input, so every input the guardrails read to decide a tier or an
 * approval scope must be literal in a flow (the validator refuses a templated
 * one). This pins that every input-aware branch of checkGuardrails /
 * resolveApprovalScope has its deciding keys declared — a new input-aware
 * branch without an entry here would let a template pick its own tier at run
 * time.
 */
describe('TIER_DECIDING_INPUT_KEYS', () => {
  it('covers every whole-tool input-aware tier-3 tool and the input-aware action tools', () => {
    const required = [...TIER3_INPUT_AWARE_TOOLS, 'manage_tickets', 'manage_policy_feature_link', 'manage_organizations'];
    for (const name of required) {
      expect(TIER_DECIDING_INPUT_KEYS[name], name).toBeDefined();
      expect(TIER_DECIDING_INPUT_KEYS[name]!.length, name).toBeGreaterThan(0);
    }
  });

  it('pins the deciding field of each input-aware branch', () => {
    expect(TIER_DECIDING_INPUT_KEYS.manage_tickets).toEqual(['isPublic']);
    expect([...TIER_DECIDING_INPUT_KEYS.manage_policy_feature_link!].sort()).toEqual(['featureType', 'inlineSettings']);
    expect(TIER_DECIDING_INPUT_KEYS.s1_isolate_device).toEqual(['isolate']);
    expect(TIER_DECIDING_INPUT_KEYS.run_script).toEqual(['proposalId']);
    expect(TIER_DECIDING_INPUT_KEYS.manage_organizations).toEqual(['status']);
  });

  it('tierDecidingInputKeys leads with the action selector and includes every live-read flag', () => {
    expect(tierDecidingInputKeys('manage_tickets')).toEqual(['action', 'isPublic']);
    const custom = Object.entries(TOOL_ACTION_INPUT_KEYS)[0]!;
    expect(tierDecidingInputKeys(custom[0])[0]).toBe(custom[1]);
    for (const [tool, flag] of Object.entries(LIVE_READ_INPUT_FLAGS)) {
      expect(tierDecidingInputKeys(tool)).toContain(flag);
    }
    expect(tierDecidingInputKeys('get_device_details')).toEqual(['action']);
  });
});
