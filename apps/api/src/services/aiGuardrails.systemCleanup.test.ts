import { describe, expect, it } from 'vitest';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 4 and the design constraint
 * "TIER3_ACTIONS.system_cleanup = ['run'] in BOTH guardrail tables".
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry, because the
 * base tier is half of what checkGuardrails resolves.
 */
import {
  TIER3_ACTIONS,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_SUPERVISED_ACTIONS,
  TOOL_PERMISSIONS,
  checkGuardrails,
} from './aiGuardrails';

describe('system_cleanup guardrails', () => {
  it('escalates run — and only run — to Tier 3', () => {
    expect(TIER3_ACTIONS.system_cleanup).toEqual(['run']);
    expect(checkGuardrails('system_cleanup', { action: 'run' }).tier).toBe(3);
    expect(checkGuardrails('system_cleanup', { action: 'list' }).tier).toBe(1);
  });

  it('classifies run as supervised, not four-eyes', () => {
    // A tech who could open Disk Cleanup on the box by hand can approve the
    // AI doing it; nothing here is externally binding, financial or
    // state-destroying. The contract test in
    // aiGuardrails.approvalScope.contract.test.ts fails if the pair is in
    // NEITHER table or in BOTH.
    expect(TIER3_SUPERVISED_ACTIONS.system_cleanup).toEqual(['run']);
    expect(TIER3_FOUR_EYES_ACTIONS.system_cleanup).toBeUndefined();
    expect(checkGuardrails('system_cleanup', { action: 'run' }).approvalScope).toBe('supervised');
  });

  it('maps RBAC per action: list reads devices, run executes on them', () => {
    expect(TOOL_PERMISSIONS.system_cleanup).toEqual({
      list: { resource: 'devices', action: 'read' },
      run: { resource: 'devices', action: 'execute' },
    });
  });
});
