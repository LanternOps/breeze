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
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from './aiAgentSdkTools';
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

/**
 * #3156 — the allowlist above only pays off on a surface that can actually CALL
 * the tool, and the ONLY consumer of `GuardrailCheck.readOnly` is the in-product
 * chat's preToolUse (aiAgentSdk.ts). The external MCP route runs the same
 * checkGuardrails but ignores `readOnly` entirely, so an entry here that the
 * chat cannot see is 100% dead code, not merely degraded.
 *
 * What the chat can see is derived from `TOOL_TIERS` twice over:
 *   - `BREEZE_MCP_TOOL_NAMES = Object.keys(TOOL_TIERS)` is the `allowedTools`
 *     list handed to the SDK, and
 *   - `createSessionPreToolUse` rejects `!TOOL_TIERS[toolName]` as "Unknown tool".
 *
 * All nine tools #3156 shipped into TIER2_READONLY_TOOLS were absent from
 * TOOL_TIERS, so the chat replied "I don't have an invoicing tool" while the
 * allowlist claimed to be optimising its prompts. Nothing failed. These tests
 * are the missing link between the two maps.
 */
describe('TIER2_READONLY_TOOLS is reachable by the chat (#3156)', () => {
  /** Tool names declared via `tool('<name>', ...)` in the breeze SDK MCP server. */
  const declaredToolNames = new Set(
    Array.from(
      readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8')
        .matchAll(/\btool\(\s*'([a-z0-9_]+)'/g),
      // Group 1 is non-optional in this pattern, so a match always has it.
      (m) => m[1]!,
    ),
  );

  it('every member has a TOOL_TIERS entry', () => {
    const missing = Array.from(TIER2_READONLY_TOOLS).filter(
      (tool) => !(tool in (TOOL_TIERS as Record<string, number>)),
    );
    expect(
      missing,
      'these tools are on the read-only auto-execute allowlist but missing from TOOL_TIERS, so '
        + 'BREEZE_MCP_TOOL_NAMES omits them and createSessionPreToolUse rejects them as '
        + '"Unknown tool" — the chat can never call them and the allowlist entry is dead (#3156)',
    ).toEqual([]);
  });

  it('every member has a tool() declaration in createBreezeMcpServer', () => {
    const undeclared = Array.from(TIER2_READONLY_TOOLS).filter(
      (tool) => !declaredToolNames.has(tool),
    );
    expect(
      undeclared,
      'a TOOL_TIERS entry alone only allowlists the mcp__breeze__ name; without a tool() '
        + 'declaration no such tool exists and the model silently picks a neighbour (#2605)',
    ).toEqual([]);
  });

  it('the TOOL_TIERS entry agrees with the aiTools registry tier', () => {
    // checkGuardrails resolves the base tier from the REGISTRY, not TOOL_TIERS.
    // A divergence would make the readOnly annotation above and the tier the
    // chat is gated on describe two different tools.
    for (const tool of TIER2_READONLY_TOOLS) {
      expect((TOOL_TIERS as Record<string, number>)[tool], tool).toBe(getToolTier(tool));
    }
  });
});

/**
 * #3156 companion: the two mutating billing/contract tools were exposed to chat
 * in the same change. They are deliberately NOT on any read-only allowlist, so
 * every action must still reach an approval prompt — Tier 2 (per-step prompt
 * under the default mode) for draft edits, Tier 3 (durable action intent) for
 * the financially-final ones.
 */
describe('billing/contract mutators still prompt (#3156)', () => {
  it.each([
    ['manage_invoices', 'create_draft'],
    ['manage_invoices', 'delete_draft'],
    ['manage_contracts', 'create_draft'],
    ['manage_contracts', 'delete_draft'],
  ])('%s (%s) resolves to tier 2 without readOnly', (tool, action) => {
    const check = checkGuardrails(tool, { action });
    expect(check.tier).toBe(2);
    expect(check.readOnly).toBeUndefined();
    expect(TIER2_READONLY_TOOLS.has(tool)).toBe(false);
  });

  it.each([
    ['manage_invoices', 'issue'],
    ['manage_invoices', 'void'],
    ['manage_invoices', 'record_payment'],
    ['manage_invoices', 'void_payment'],
    ['manage_contracts', 'activate'],
    ['manage_contracts', 'pause'],
    ['manage_contracts', 'resume'],
    ['manage_contracts', 'cancel'],
  ])('%s (%s) escalates to tier 3 and requires approval', (tool, action) => {
    const check = checkGuardrails(tool, { action });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.readOnly).toBeUndefined();
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
