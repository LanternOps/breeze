import { describe, expect, it } from 'vitest';
import { SUPPORTED_AGENT_MODES, isSupportedAgentMode } from './constants';

describe('SUPPORTED_AGENT_MODES', () => {
  it("admits only 'off' and 'shadow' — 'act' ships in wave 4", () => {
    // The DB CHECK already admits 'act', so this constant is the only thing
    // standing between a policy write and an autonomously-acting agent.
    expect([...SUPPORTED_AGENT_MODES].sort()).toEqual(['off', 'shadow']);
    expect(isSupportedAgentMode('act')).toBe(false);
    expect(isSupportedAgentMode('off')).toBe(true);
    expect(isSupportedAgentMode('shadow')).toBe(true);
    expect(isSupportedAgentMode('bogus')).toBe(false);
  });
});
