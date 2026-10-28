import { describe, expect, it } from 'vitest';
import {
  TIER1_READ_ACTIONS, TIER2_ACTIONS, TIER3_ACTIONS, TIER3_SUPERVISED_TOOLS, checkGuardrails, isInputAwareTier3,
} from './aiGuardrails';
import { isMfaGatedToolAction } from './aiToolMfaGate';
import { softwareToolSchemas } from './aiToolSchemasSoftware';

/**
 * Full-control W12 (#6782, review): every W12 write is MFA-gated (W12-D5, REST
 * `requireMfa()` parity) and no read is; the partner-wide create arms escalate
 * only on the literal `ownerScope: 'partner'`.
 */
const W12 = Object.keys(softwareToolSchemas) as Array<keyof typeof softwareToolSchemas>;

function actionsOf(tool: keyof typeof softwareToolSchemas): string[] | undefined {
  const action = (softwareToolSchemas[tool].shape as Record<string, unknown>).action as { options?: readonly string[] } | undefined;
  return action?.options ? [...action.options] : undefined;
}

describe('W12 MFA gate covers every write and no read (#6782)', () => {
  it.each(W12)('%s', (tool) => {
    const actions = actionsOf(tool);
    if (!actions) {
      // Single-purpose tools: reads are never gated, the two device writes always are.
      const isWrite = TIER3_SUPERVISED_TOOLS.has(tool);
      expect(isMfaGatedToolAction(tool, undefined), tool).toBe(isWrite);
      return;
    }
    const reads = new Set(TIER1_READ_ACTIONS[tool] ?? []);
    for (const action of actions) {
      expect(isMfaGatedToolAction(tool, action), `${tool}:${action}`).toBe(!reads.has(action));
    }
  });

  it('every non-read W12 action is classified tier 2 or tier 3', () => {
    for (const tool of W12) {
      const actions = actionsOf(tool) ?? [];
      const reads = new Set(TIER1_READ_ACTIONS[tool] ?? []);
      for (const action of actions.filter((a) => !reads.has(a))) {
        const classified = (TIER2_ACTIONS[tool] ?? []).includes(action) || (TIER3_ACTIONS[tool] ?? []).includes(action);
        expect(classified, `${tool}:${action}`).toBe(true);
      }
    }
  });
});

describe('W12 partner-wide create arms escalate only on the literal partner scope (QW1)', () => {
  it.each([
    ['manage_software_catalog', 'create'],
    ['manage_custom_fields', 'create_definition'],
  ] as const)('%s:%s', (tool, action) => {
    expect(isInputAwareTier3(tool, action, { ownerScope: 'partner' })).toBe(true);
    for (const ownerScope of ['organization', 'Partner', 'org', undefined, 1]) {
      expect(isInputAwareTier3(tool, action, { ownerScope }), String(ownerScope)).toBe(false);
    }
    // Another action never escalates on ownerScope.
    expect(isInputAwareTier3(tool, 'update', { ownerScope: 'partner' })).toBe(false);
    expect(checkGuardrails(tool, { action, ownerScope: 'partner' }).tier).toBe(3);
    expect(checkGuardrails(tool, { action, ownerScope: 'organization' }).tier).toBe(2);
  });
});
