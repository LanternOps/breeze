/** #11610 — the degraded post names why a run-mode check-in could not start. */
import { describe, expect, it } from 'vitest';
import { degradeReasonText, degradedBody } from './checkInRuns';

describe('degradeReasonText', () => {
  it.each([
    ['no_effective_agent', 'no Triage agent is switched on for this organization'],
    ['agent_disabled', 'no Triage agent is switched on for this organization'],
    ['mode_off', "the organization's Triage agent is set to mode Off"],
    ['kill_switch_off', 'AI agents are turned off on this server'],
    ['budget_exhausted', "today's budget is spent"],
    ['grant_revision_changed', 'the grant changed since this was scheduled'],
    ['something_else', 'the check could not start'],
  ])('%s → %s', (skipped, text) => {
    expect(degradeReasonText(skipped)).toBe(text);
  });

  it('degradedBody carries the cause into the post', () => {
    expect(degradedBody('no_effective_agent', 'Check X.')).toBe(
      "I couldn't check on my own: no Triage agent is switched on for this organization. Run it now? Check X.",
    );
  });
});
