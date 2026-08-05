/**
 * Contract tests for the #3130 read-only Tier-2 auto-execution allowlists
 * (TIER2_READONLY_ACTIONS / TIER2_READONLY_TOOLS in aiGuardrails.ts).
 *
 * These allowlists let strictly-read-only Tier-2 calls skip the per_step
 * approval prompt while keeping the Tier-2 audit-ledger row. The safety of
 * that skip rests on two structural claims this suite pins down:
 *
 *   1. TIER2_READONLY_ACTIONS is a SUBSET of TIER2_ACTIONS — an entry here
 *      can never grant a tier, only annotate one that TIER2_ACTIONS already
 *      resolves. A pair present here but absent there is dead (checkGuardrails
 *      would resolve some other tier first) and almost certainly a mistake.
 *   2. TIER2_READONLY_TOOLS members are single-purpose read tools: registered
 *      at base tier 2 and absent from ALL per-action tier tables — a tool
 *      that multiplexes actions has mutating surface and cannot be declared
 *      wholly read-only by name.
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry, because base
 * tiers are half the answer (same rationale as aiGuardrailsTierConfig.parity.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';
import { getToolTier } from './aiTools';

describe('TIER2_READONLY_ACTIONS ⊆ TIER2_ACTIONS (#3130)', () => {
  it('every read-only action pair is present in TIER2_ACTIONS', () => {
    for (const [tool, actions] of Object.entries(TIER2_READONLY_ACTIONS)) {
      for (const action of actions) {
        expect(TIER2_ACTIONS[tool] ?? [], `${tool} (${action})`).toContain(action);
      }
    }
  });

  it('resolves every pair to tier 2 with readOnly: true through checkGuardrails', () => {
    for (const [tool, actions] of Object.entries(TIER2_READONLY_ACTIONS)) {
      const key = TOOL_ACTION_INPUT_KEYS[tool] ?? 'action';
      for (const action of actions) {
        const check = checkGuardrails(tool, { [key]: action });
        expect(check.tier, `${tool} (${action})`).toBe(2);
        expect(check.readOnly, `${tool} (${action})`).toBe(true);
      }
    }
  });
});

describe('TIER2_READONLY_TOOLS — wholly read-only base-Tier-2 tools (#3130)', () => {
  it('every member is registered at base tier 2', () => {
    for (const tool of TIER2_READONLY_TOOLS) {
      expect(getToolTier(tool), tool).toBe(2);
    }
  });

  it('no member multiplexes actions through any tier table (single-purpose reads only)', () => {
    for (const tool of TIER2_READONLY_TOOLS) {
      expect(TIER1_ACTIONS[tool], tool).toBeUndefined();
      expect(TIER2_ACTIONS[tool], tool).toBeUndefined();
      expect(TIER3_ACTIONS[tool], tool).toBeUndefined();
      expect(TOOL_ACTION_INPUT_KEYS[tool], tool).toBeUndefined();
    }
  });

  it('resolves every member to tier 2 with readOnly: true through checkGuardrails', () => {
    for (const tool of TIER2_READONLY_TOOLS) {
      const check = checkGuardrails(tool, {});
      expect(check.tier, tool).toBe(2);
      expect(check.readOnly, tool).toBe(true);
    }
  });
});

describe('readOnly never leaks outside the allowlists (#3130)', () => {
  it('mutating Tier-2 actions do not carry readOnly', () => {
    expect(checkGuardrails('manage_alerts', { action: 'acknowledge' }).readOnly).toBeUndefined();
    expect(checkGuardrails('manage_tickets', { action: 'create' }).readOnly).toBeUndefined();
    expect(checkGuardrails('manage_patches', { action: 'bulk_approve' }).readOnly).toBeUndefined();
  });

  it('Tier-3 execute_command types do not carry readOnly even when nominally reads', () => {
    for (const commandType of ['event_logs_query', 'list_services', 'file_read']) {
      const check = checkGuardrails('execute_command', { commandType });
      expect(check.tier, commandType).toBe(3);
      expect(check.readOnly, commandType).toBeUndefined();
    }
  });

  it('an unknown or missing commandType stays at base tier without readOnly (fail-closed)', () => {
    expect(checkGuardrails('execute_command', {}).readOnly).toBeUndefined();
    expect(checkGuardrails('execute_command', { commandType: 'made_up' }).readOnly).toBeUndefined();
    expect(checkGuardrails('execute_command', { commandType: 42 as unknown as string }).readOnly).toBeUndefined();
  });
});
