import { describe, expect, it } from 'vitest';
import { GOLDEN_CASES } from './goldenPrompts';
import { TUNING_CASES, tuningPromptNamesTool } from './tuningPrompts';
import { aiTools } from '../../aiTools';

describe('TUNING_CASES', () => {
  it('no id collides with GOLDEN_CASES (tuning cases never feed the golden set)', () => {
    const golden = new Set(GOLDEN_CASES.map((c) => c.id));
    expect(TUNING_CASES.filter((c) => golden.has(c.id))).toEqual([]);
  });

  it('no prompt names a registry tool as a word (the inflation guard)', () => {
    const names = [...aiTools.keys()];
    expect(TUNING_CASES.filter((c) => tuningPromptNamesTool(c.prompt, names))).toEqual([]);
  });

  it('control: the guard flags a prompt that says a tool name', () => {
    const names = [...aiTools.keys()];
    expect(tuningPromptNamesTool('please run manage_services for me', names)).toBe(true);
    expect(tuningPromptNamesTool('restart the print spooler on a workstation', names)).toBe(false);
  });
});
