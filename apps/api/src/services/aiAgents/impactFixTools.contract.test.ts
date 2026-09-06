import { describe, expect, it } from 'vitest';
import { ACT_ELIGIBLE_TOOL_NAMES } from './actManifest';
import { POLICY_DECIDABLE_TIER3 } from '../actionIntents/policyDecidable';
import { IMPACT_FIX_TOOLS } from './impactFixTools';

describe('IMPACT_FIX_TOOLS is the pinned union of the two closed registries', () => {
  const derived = [...new Set([
    ...ACT_ELIGIBLE_TOOL_NAMES,
    ...POLICY_DECIDABLE_TIER3.map((e) => e.toolName),
  ])].sort();

  it('equals ACT_ELIGIBLE_TOOL_NAMES union POLICY_DECIDABLE_TIER3 tool names', () => {
    expect(
      [...IMPACT_FIX_TOOLS],
      'A manifest or policy-decidable tool changed. Update the IMPACT_FIX_TOOLS '
      + 'literal deliberately — a new remediation tool must be a conscious '
      + 'addition to what counts as customer value, not a silent one.',
    ).toEqual(derived);
  });

  it('excludes the remediation_suggestion sentinel (never a real dispatched tool name)', () => {
    expect(IMPACT_FIX_TOOLS).not.toContain('remediation_suggestion');
  });

  it('excludes the non-remediation agent tools, so a suppression is never a fix', () => {
    for (const tool of ['manage_alerts', 'manage_tickets', 'manage_ai_agents']) {
      expect(IMPACT_FIX_TOOLS, tool).not.toContain(tool);
    }
  });

  it('is frozen and sorted', () => {
    expect(Object.isFrozen(IMPACT_FIX_TOOLS)).toBe(true);
    expect([...IMPACT_FIX_TOOLS]).toEqual([...IMPACT_FIX_TOOLS].sort());
  });
});
