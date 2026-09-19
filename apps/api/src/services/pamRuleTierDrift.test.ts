import { describe, it, expect } from 'vitest';
import {
  describePamRuleTierDrift,
  reachableRiskTiersForAnyTool,
  reachableRiskTiersForTool,
} from './pamRuleTierDrift';
import {
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';
import { getAllRegisteredToolNames } from './aiTools';

describe('reachableRiskTiersForTool', () => {
  it('reports every tier an action-multiplexed tool can currently resolve to', () => {
    // #3088/#3105 downgraded three read-only commandTypes to Tier 2 while
    // file_read/kill_process stayed Tier 3, so execute_command spans both.
    expect(reachableRiskTiersForTool('execute_command')).toEqual([2, 3]);
  });

  it('returns the base tier alone for a tool with no per-action overrides', () => {
    // An unenumerated action always falls through to the base tier, so the
    // base tier is reachable for every registered tool.
    const tiers = reachableRiskTiersForTool('get_device_details');
    expect(tiers).not.toBeNull();
    expect(tiers).toEqual([checkGuardrails('get_device_details', {}).tier]);
  });

  it('resolves the tool name case-insensitively, like the rule engine', () => {
    // pamRuleEngine matches matchToolName with eqCi — a validator that only
    // did an exact lookup would silently skip mixed-case rules.
    expect(reachableRiskTiersForTool('Execute_Command')).toEqual([2, 3]);
  });

  it('returns null for a tool the registry does not know', () => {
    expect(reachableRiskTiersForTool('definitely_not_a_registered_tool')).toBeNull();
  });
});

describe('reachableRiskTiersForAnyTool', () => {
  it('is the union over every registered tool', () => {
    expect(reachableRiskTiersForAnyTool()).toEqual([1, 2, 3]);
  });
});

describe('describePamRuleTierDrift', () => {
  it('accepts the tier a rule shares with only SOME of the tool actions (#3128)', () => {
    // The literal #3128 rule: execute_command + tier 3. It stopped covering
    // the three downgraded commandTypes but still covers file_read etc, so it
    // is narrowed, not dead — and must NOT be rejected.
    expect(describePamRuleTierDrift({ matchToolName: 'execute_command', matchRiskTier: 3 })).toBeNull();
  });

  it('accepts the tier the downgraded actions moved to', () => {
    expect(describePamRuleTierDrift({ matchToolName: 'execute_command', matchRiskTier: 2 })).toBeNull();
  });

  it('flags a tier the selected tool can never resolve to', () => {
    const drift = describePamRuleTierDrift({ matchToolName: 'execute_command', matchRiskTier: 1 });
    expect(drift).not.toBeNull();
    expect(drift!.validTiers).toEqual([2, 3]);
    expect(drift!.matchRiskTier).toBe(1);
    expect(drift!.matchToolName).toBe('execute_command');
    expect(drift!.message).toContain('execute_command');
    expect(drift!.message).toContain('2, 3');
  });

  it('flags tier 4, which the schema allows but no registered tool resolves to', () => {
    expect(describePamRuleTierDrift({ matchToolName: 'execute_command', matchRiskTier: 4 })).not.toBeNull();
  });

  it('flags a tier no tool at all resolves to when the rule names no tool', () => {
    const drift = describePamRuleTierDrift({ matchRiskTier: 0 });
    expect(drift).not.toBeNull();
    expect(drift!.matchToolName).toBeNull();
    expect(drift!.validTiers).toEqual([1, 2, 3]);
  });

  it('accepts a tool-less rule on a tier some tool still uses', () => {
    expect(describePamRuleTierDrift({ matchRiskTier: 3 })).toBeNull();
  });

  it('fails OPEN for an unrecognised tool name rather than blocking the write', () => {
    // Extension tools are per-tenant and may not be resolvable here; a rule
    // naming one must never be rejected on tier grounds.
    expect(
      describePamRuleTierDrift({ matchToolName: 'some_extension_tool', matchRiskTier: 3 }),
    ).toBeNull();
  });

  // A negated criterion inverts the comparison in pamRuleEngine's satisfied():
  // matchNegate:['riskTier'] means "tier is NOT this", which stays useful even
  // when the pinned tier is unreachable. Rejecting those would break rules that
  // match perfectly well today.
  it('ignores a NEGATED tier — an unreachable tier excludes nothing, it is not dead', () => {
    expect(
      describePamRuleTierDrift({
        matchToolName: 'execute_command',
        matchRiskTier: 1,
        matchNegate: ['riskTier'],
      }),
    ).toBeNull();
  });

  it('measures against ALL tools when the tool name itself is negated', () => {
    // "any tool EXCEPT execute_command, at tier 1" — tier 1 is unreachable for
    // execute_command but plenty of other tools resolve to it.
    expect(
      describePamRuleTierDrift({
        matchToolName: 'execute_command',
        matchRiskTier: 1,
        matchNegate: ['toolName'],
      }),
    ).toBeNull();
  });

  it('still flags a globally unreachable tier when the tool name is negated', () => {
    const drift = describePamRuleTierDrift({
      matchToolName: 'execute_command',
      matchRiskTier: 0,
      matchNegate: ['toolName'],
    });
    expect(drift).not.toBeNull();
    expect(drift!.validTiers).toEqual([1, 2, 3]);
  });

  it('is unaffected by negation of an unrelated criterion', () => {
    expect(
      describePamRuleTierDrift({
        matchToolName: 'execute_command',
        matchRiskTier: 1,
        matchNegate: ['user'],
      }),
    ).not.toBeNull();
  });

  it('ignores rules that set no tier at all', () => {
    expect(describePamRuleTierDrift({ matchToolName: 'execute_command' })).toBeNull();
    expect(describePamRuleTierDrift({})).toBeNull();
    expect(describePamRuleTierDrift({ matchRiskTier: null, matchToolName: null })).toBeNull();
  });
});

describe('reachable-tier contract with checkGuardrails', () => {
  it('covers every tier checkGuardrails can actually return for every registered tool', () => {
    // The bug in #3128 is a hand-maintained mirror drifting from the real
    // resolver. This asserts the drift detector is DERIVED from checkGuardrails
    // rather than duplicating its table lookups.
    const mismatches: string[] = [];
    for (const toolName of getAllRegisteredToolNames()) {
      const reachable = reachableRiskTiersForTool(toolName);
      if (reachable === null) {
        mismatches.push(`${toolName}: registered but reported unknown`);
        continue;
      }
      const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
      const actions = [
        ...new Set([
          ...(TIER1_ACTIONS[toolName] ?? []),
          ...(TIER2_ACTIONS[toolName] ?? []),
          ...(TIER3_ACTIONS[toolName] ?? []),
        ]),
      ];
      for (const probe of [{}, ...actions.map((a) => ({ [actionKey]: a }))]) {
        const tier = checkGuardrails(toolName, probe).tier;
        if (!reachable.includes(tier)) {
          mismatches.push(`${toolName} ${JSON.stringify(probe)} -> tier ${tier} not in [${reachable}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
