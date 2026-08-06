/**
 * Contract test for the tier-3 supervised/four_eyes approval-scope split
 * (2026-08-05 tier3-supervised-four-eyes design, §3.1).
 *
 * Modeled on aiGuardrails.readonly.contract.test.ts: no vi.mock — this suite
 * needs the REAL aiTools registry, because base tiers are half the answer.
 */
import { describe, it, expect } from 'vitest';
import {
  TIER3_ACTIONS, TIER3_FOUR_EYES_ACTIONS, TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS, TIER3_SUPERVISED_TOOLS,
  TIER3_INPUT_AWARE_ACTIONS, TIER3_INPUT_AWARE_TOOLS,
  checkGuardrails, resolveApprovalScope,
} from './aiGuardrails';
import { getToolTier, getAllRegisteredToolNames } from './aiTools';

describe('tier-3 approval scope classification', () => {
  it('classifies every per-action tier-3 pair in exactly one scope', () => {
    for (const [tool, actions] of Object.entries(TIER3_ACTIONS)) {
      for (const action of actions) {
        // Input-aware pairs (e.g. manage_organizations:update_org) are
        // resolved dynamically by resolveApprovalScope's override hooks, not
        // these static tables — covered by their own both-branches tests below.
        if (TIER3_INPUT_AWARE_ACTIONS.has(`${tool}:${action}`)) continue;
        const inFourEyes = TIER3_FOUR_EYES_ACTIONS[tool]?.includes(action) ?? false;
        const inSupervised = TIER3_SUPERVISED_ACTIONS[tool]?.includes(action) ?? false;
        expect(inFourEyes !== inSupervised, `${tool}:${action} must be in exactly one scope table`).toBe(true);
      }
    }
  });

  it('classifies every base-tier-3 tool in exactly one whole-tool scope set', () => {
    for (const tool of getAllRegisteredToolNames()) {
      if (getToolTier(tool) !== 3) continue;
      // Input-aware tools (e.g. s1_isolate_device) are resolved dynamically —
      // covered by their own both-branches tests below.
      if (TIER3_INPUT_AWARE_TOOLS.has(tool)) continue;
      const inFourEyes = TIER3_FOUR_EYES_TOOLS.has(tool);
      const inSupervised = TIER3_SUPERVISED_TOOLS.has(tool);
      expect(inFourEyes !== inSupervised, `${tool} must be in exactly one whole-tool scope set`).toBe(true);
    }
  });

  it('scope tables reference only real tier-3 surfaces', () => {
    for (const [tool, actions] of Object.entries(TIER3_FOUR_EYES_ACTIONS)) {
      for (const a of actions) expect(TIER3_ACTIONS[tool] ?? []).toContain(a);
    }
    for (const tool of TIER3_FOUR_EYES_TOOLS) expect(getToolTier(tool)).toBe(3);
  });

  it('defaults unclassified to four_eyes (fail-safe)', () => {
    expect(resolveApprovalScope('some_future_unclassified_tool', undefined, {})).toBe('four_eyes');
  });

  it('update_org is input-aware: exempt from the static per-action tables', () => {
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_organizations:update_org')).toBe(true);
    expect(TIER3_FOUR_EYES_ACTIONS.manage_organizations ?? []).not.toContain('update_org');
    expect(TIER3_SUPERVISED_ACTIONS.manage_organizations ?? []).not.toContain('update_org');
  });

  it('update_org escalates to four_eyes only when a status change is present', () => {
    expect(
      resolveApprovalScope('manage_organizations', 'update_org', { orgId: 'o1', status: 'suspended' }),
    ).toBe('four_eyes');
    expect(
      resolveApprovalScope('manage_organizations', 'update_org', { orgId: 'o1', name: 'Renamed' }),
    ).toBe('supervised');
  });

  it('checkGuardrails surfaces update_org\'s input-aware scope', () => {
    const withStatus = checkGuardrails('manage_organizations', { action: 'update_org', orgId: 'o1', status: 'suspended' });
    expect(withStatus.tier).toBe(3);
    expect(withStatus.approvalScope).toBe('four_eyes');
    const withoutStatus = checkGuardrails('manage_organizations', { action: 'update_org', orgId: 'o1', name: 'Renamed' });
    expect(withoutStatus.tier).toBe(3);
    expect(withoutStatus.approvalScope).toBe('supervised');
  });

  it('s1_isolate_device is input-aware: exempt from the static whole-tool sets', () => {
    expect(TIER3_INPUT_AWARE_TOOLS.has('s1_isolate_device')).toBe(true);
    expect(TIER3_FOUR_EYES_TOOLS.has('s1_isolate_device')).toBe(false);
    expect(TIER3_SUPERVISED_TOOLS.has('s1_isolate_device')).toBe(false);
  });

  it('s1_isolate_device escalates to four_eyes only on isolate:false (containment release)', () => {
    // isolate:false — release, reverses a prior mitigation.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1', isolate: false })).toBe('four_eyes');
    // isolate:true — urgent protective containment, must not wait.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1', isolate: true })).toBe('supervised');
    // isolate missing — fail toward the urgent-containment default, not the stricter one.
    expect(resolveApprovalScope('s1_isolate_device', undefined, { deviceId: 'd1' })).toBe('supervised');
  });

  it('checkGuardrails surfaces the scope on tier-3 results', () => {
    const fourEyes = checkGuardrails('manage_invoices', { action: 'issue' });
    expect(fourEyes.tier).toBe(3);
    expect(fourEyes.approvalScope).toBe('four_eyes');
    const supervised = checkGuardrails('manage_services', { action: 'restart' });
    expect(supervised.tier).toBe(3);
    expect(supervised.approvalScope).toBe('supervised');
    const tier2 = checkGuardrails('manage_patches', { action: 'approve' });
    expect(tier2.approvalScope).toBeUndefined();
  });
});
