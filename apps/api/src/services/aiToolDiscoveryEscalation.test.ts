import { describe, expect, it } from 'vitest';
import {
  TIER1_ACTIONS, TIER2_ACTIONS, TIER3_ACTIONS, TOOL_ACTION_INPUT_KEYS, checkGuardrails,
} from './aiGuardrails';
import { aiTools } from './aiTools';
import { isEscalatedCall } from './aiToolDiscoveryEscalation';

describe('isEscalatedCall', () => {
  it('true for run_script (base tier 3)', () => {
    expect(isEscalatedCall('run_script', {})).toBe(true);
  });

  it('true for manage_services {action:restart}', () => {
    expect(isEscalatedCall('manage_services', { action: 'restart' })).toBe(true);
  });

  it('true for an execute_command commandType in no downgrade map', () => {
    expect(isEscalatedCall('execute_command', { commandType: 'definitely_not_a_listed_command' })).toBe(true);
  });

  it('false for execute_command {commandType:list_processes} (TIER2_ACTIONS)', () => {
    expect(isEscalatedCall('execute_command', { commandType: 'list_processes' })).toBe(false);
  });

  it('false for manage_alerts {action:list} and for query_devices', () => {
    expect(isEscalatedCall('manage_alerts', { action: 'list' })).toBe(false);
    expect(isEscalatedCall('query_devices', {})).toBe(false);
  });

  it('false for an unknown tool', () => {
    expect(isEscalatedCall('no_such_tool_anywhere', {})).toBe(false);
  });

  it('agrees with checkGuardrails(...).tier === 3 for every (tool, action) pair in the three maps and every base-tier-3 tool with no action', () => {
    const disagreements: string[] = [];
    let compared = 0;
    const compare = (tool: string, input: Record<string, unknown>) => {
      compared += 1;
      const expected = checkGuardrails(tool, input).tier === 3;
      if (isEscalatedCall(tool, input) !== expected) disagreements.push(`${tool} ${JSON.stringify(input)} expected ${expected}`);
    };
    for (const map of [TIER1_ACTIONS, TIER2_ACTIONS, TIER3_ACTIONS]) {
      for (const [tool, actions] of Object.entries(map)) {
        const key = TOOL_ACTION_INPUT_KEYS[tool] ?? 'action';
        for (const action of actions) compare(tool, { [key]: action });
      }
    }
    for (const [name, tool] of aiTools) {
      if (tool.tier === 3) compare(name, {});
    }
    expect(compared).toBeGreaterThan(200);
    expect(disagreements).toEqual([]);
  });

  it('agrees with checkGuardrails for input-aware tier 3 escalations (manage_tickets comment isPublic)', () => {
    const input = { action: 'comment', isPublic: true };
    expect(isEscalatedCall('manage_tickets', input)).toBe(checkGuardrails('manage_tickets', input).tier === 3);
    expect(isEscalatedCall('manage_tickets', input)).toBe(true);
  });
});
