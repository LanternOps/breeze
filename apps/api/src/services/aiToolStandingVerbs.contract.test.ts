/**
 * CONTRACT (#10428 W06): every device-changing tool says which standing-
 * instruction verbs it can break.
 *
 * A Tier >= 2 tool (by its base tier, or by any of its actions) that takes a
 * device id in `deviceArgs` must have an entry in
 * STANDING_INSTRUCTION_VERB_MAP: verbs, or an explicit `'none'` for a tool
 * that changes nothing on the device. A tool with no entry never matches a
 * remembered "don't reboot PC-01", so a new device tool fails here until it is
 * classified. An entry naming a tool that is not in TOOL_TIERS is stale.
 */
import { describe, expect, it } from 'vitest';
import { STANDING_VERBS } from '@breeze/shared';
import { aiTools } from './aiTools';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_SUPERVISED_ACTIONS,
} from './aiGuardrails';
import { STANDING_INSTRUCTION_VERB_MAP } from './aiToolStandingVerbs';

function changingActions(toolName: string): Set<string> {
  return new Set([
    ...(TIER2_ACTIONS[toolName] ?? []),
    ...(TIER3_ACTIONS[toolName] ?? []),
    ...(TIER3_FOUR_EYES_ACTIONS[toolName] ?? []),
    ...(TIER3_SUPERVISED_ACTIONS[toolName] ?? []),
  ]);
}

const required = Object.entries(TOOL_TIERS as Record<string, number>)
  .filter(([name, tier]) => tier >= 2 || changingActions(name).size > 0)
  .filter(([name]) => (aiTools.get(name)?.deviceArgs ?? []).length > 0)
  .map(([name]) => name)
  .sort();

describe('contract: standing-instruction verb map covers every Tier >= 2 device tool', () => {
  it('finds the device tools it guards (the discovery itself is not empty)', () => {
    expect(required.length).toBeGreaterThan(20);
    expect(required).toContain('run_script');
    expect(required).toContain('manage_patches');
  });

  it('every Tier >= 2 device tool has an entry (verbs or an explicit none)', () => {
    const missing = required.filter((name) => !(name in STANDING_INSTRUCTION_VERB_MAP));
    expect(missing, `classify these in services/aiToolStandingVerbs.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('every enforced entry names a registry tool with deviceArgs (its devices are where matching happens)', () => {
    const blind = Object.entries(STANDING_INSTRUCTION_VERB_MAP)
      .filter(([, rule]) => rule !== 'none')
      .map(([name]) => name)
      .filter((name) => (aiTools.get(name)?.deviceArgs ?? []).length === 0);
    expect(blind).toEqual([]);
  });

  it('no entry names a tool that is absent from TOOL_TIERS', () => {
    const stale = Object.keys(STANDING_INSTRUCTION_VERB_MAP).filter((name) => !(name in TOOL_TIERS));
    expect(stale).toEqual([]);
  });

  it('every verb an entry names is a standing verb, and every byAction key is a real action', () => {
    const verbs = new Set<string>(STANDING_VERBS);
    for (const [name, rule] of Object.entries(STANDING_INSTRUCTION_VERB_MAP)) {
      if (rule === 'none') continue;
      const rules = [rule, ...Object.values(rule.byAction ?? {})];
      for (const r of rules) {
        if (r === 'none') continue;
        for (const v of [...r.verbs, ...(r.possible ?? [])]) expect(verbs.has(v), `${name}: ${v}`).toBe(true);
      }
      const schema = aiTools.get(name)?.definition.input_schema as
        | { properties?: Record<string, { enum?: unknown[] }> }
        | undefined;
      const actionEnum = schema?.properties?.action?.enum ?? schema?.properties?.commandType?.enum;
      for (const action of Object.keys(rule.byAction ?? {})) {
        expect(actionEnum, `${name} has byAction but no action enum`).toBeDefined();
        expect(actionEnum, `${name}.${action}`).toContain(action);
      }
    }
  });
});
