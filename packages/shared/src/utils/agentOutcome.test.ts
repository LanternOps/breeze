import { describe, it, expect } from 'vitest';
import { outcomeFor, unattendedBlockedBy } from './agentOutcome';

describe('outcomeFor', () => {
  it('act mode: a script-gated operation (run_script) is unattended ONLY once a script is authorized', () => {
    const runScript = { tier: 3 as const, actEligible: true, actRequiresAuthorizedScripts: true };
    // No context at all = no authorized scripts (the guided create flow never
    // sets actAssets.scriptIds) — the run loop proposes, never dispatches.
    expect(outcomeFor(runScript, 'act')).toBe('approval_request');
    expect(outcomeFor(runScript, 'act', { authorizedScriptCount: 0 })).toBe('approval_request');
    expect(outcomeFor(runScript, 'act', { authorizedScriptCount: 1 })).toBe('unattended');
    // An ungated act-eligible op is unaffected by the script count.
    expect(outcomeFor({ tier: 3, actEligible: true, actRequiresAuthorizedScripts: false }, 'act', { authorizedScriptCount: 0 })).toBe('unattended');
  });

  it('unattendedBlockedBy names the missing prerequisite only when act mode would otherwise dispatch it', () => {
    const runScript = { tier: 3 as const, actEligible: true, actRequiresAuthorizedScripts: true };
    expect(unattendedBlockedBy(runScript, 'act', { authorizedScriptCount: 0 })).toBe('authorized_scripts');
    expect(unattendedBlockedBy(runScript, 'act', { authorizedScriptCount: 2 })).toBeNull();
    expect(unattendedBlockedBy(runScript, 'shadow', { authorizedScriptCount: 0 })).toBeNull();
    expect(unattendedBlockedBy({ ...runScript, actEligible: false }, 'act', { authorizedScriptCount: 0 })).toBeNull();
    expect(unattendedBlockedBy({ ...runScript, actRequiresAuthorizedScripts: false }, 'act', { authorizedScriptCount: 0 })).toBeNull();
  });

  it('act mode: an act-eligible operation is unattended', () => {
    expect(outcomeFor({ tier: 3, actEligible: true }, 'act')).toBe('unattended');
    expect(outcomeFor({ tier: 1, actEligible: true }, 'act')).toBe('unattended');
  });

  it('act mode: a non-act-eligible tier-3 operation still falls back to approval_request', () => {
    expect(outcomeFor({ tier: 3, actEligible: false }, 'act')).toBe('approval_request');
  });

  it('act mode: a non-act-eligible tier 1/2 operation falls back to logged_proposal', () => {
    expect(outcomeFor({ tier: 1, actEligible: false }, 'act')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 2, actEligible: false }, 'act')).toBe('logged_proposal');
  });

  it('shadow/off mode splits by tier alone, never unattended even when act-eligible', () => {
    expect(outcomeFor({ tier: 3, actEligible: true }, 'shadow')).toBe('approval_request');
    expect(outcomeFor({ tier: 2, actEligible: true }, 'shadow')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 1, actEligible: true }, 'off')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 3, actEligible: true }, 'off')).toBe('approval_request');
  });
});
