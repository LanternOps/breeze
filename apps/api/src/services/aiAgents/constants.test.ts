import { describe, expect, it } from 'vitest';
import { SUPPORTED_AGENT_MODES, isSupportedAgentMode } from './constants';

describe('SUPPORTED_AGENT_MODES', () => {
  it("admits 'off', 'shadow', and 'act' (wave 4 Part B, #3826)", () => {
    // The DB CHECK already admitted 'act' since wave 1; this constant was the
    // only thing standing between a policy write and an autonomously-acting
    // agent — wave 4 Part B is what actually bounds what 'act' may DO
    // (actManifest.ts's closed manifest + activation prerequisites,
    // agentService.ts), so the write path opens here.
    expect([...SUPPORTED_AGENT_MODES].sort()).toEqual(['act', 'off', 'shadow']);
    expect(isSupportedAgentMode('act')).toBe(true);
    expect(isSupportedAgentMode('off')).toBe(true);
    expect(isSupportedAgentMode('shadow')).toBe(true);
    expect(isSupportedAgentMode('bogus')).toBe(false);
  });
});
