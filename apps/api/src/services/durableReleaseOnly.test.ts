import { describe, it, expect } from 'vitest';
import { DURABLE_RELEASE_ONLY_TOOLS, requiresDurableRelease } from './actionIntents/durableRelease';
import { getToolTier } from './aiTools';

/**
 * Registry-level guards for the durable-release-only mechanism (design
 * docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md §0.a).
 *
 * The BEHAVIOURAL guarantee — that a durable-only tool never attempts the
 * inline `approved -> executing` CAS — is asserted in aiAgentSdk.test.ts
 * ("a durable-release-only tool never attempts the inline approved->executing
 * CAS"), which drives the real preToolUse path and fails if the guard is
 * removed. Deliberately NOT asserted here by inspecting source text: a
 * source-order check still passes when the effective early return is deleted
 * but the call text remains, which is false confidence, not coverage.
 */

describe('DURABLE_RELEASE_ONLY_TOOLS registry', () => {
  it('does not divert a tool that is not a member', () => {
    expect(requiresDurableRelease('get_device_details')).toBe(false);
    expect(requiresDurableRelease('execute_command')).toBe(false);
  });

  it('diverts every member', () => {
    for (const tool of DURABLE_RELEASE_ONLY_TOOLS) {
      expect(requiresDurableRelease(tool)).toBe(true);
    }
  });

  it('lists only tools that exist and are Tier 3', () => {
    // Guards future additions: a typo'd or downgraded entry would silently
    // stop protecting anything. Vacuous while the set is empty — the set is
    // populated by the M365 communications send tools, which do not exist yet.
    for (const tool of DURABLE_RELEASE_ONLY_TOOLS) {
      const tier = getToolTier(tool);
      expect(tier, `${tool} is listed but has no tier`).toBeDefined();
      expect(tier, `${tool} is durable-release-only but not Tier 3`).toBe(3);
    }
  });
});
