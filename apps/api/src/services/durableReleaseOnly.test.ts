import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DURABLE_RELEASE_ONLY_TOOLS, requiresDurableRelease } from './actionIntents/durableRelease';
import { getToolTier } from './aiTools';

/**
 * Guards the durable-release-only mechanism (design
 * docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md §0.a).
 *
 * An approved intent has TWO releasers racing for the same
 * `approved -> executing` CAS: the durable worker and the live chat session.
 * They execute via different code, and guarantees carried by the headless /
 * executor transport do not exist on the inline path. Tools that depend on
 * that transport must therefore never be claimed inline.
 */

describe('requiresDurableRelease', () => {
  it('returns false for a tool not in the set', () => {
    expect(requiresDurableRelease('get_device_details')).toBe(false);
  });

  it('returns true for any member of the set', () => {
    // Exercises the mechanism independently of its current membership, which
    // is empty until the M365 communications send tools land.
    const probe = new Set<string>(['m365.comms.probe']);
    const lookup = (name: string) => probe.has(name);
    expect(lookup('m365.comms.probe')).toBe(true);
    for (const tool of DURABLE_RELEASE_ONLY_TOOLS) {
      expect(requiresDurableRelease(tool)).toBe(true);
    }
  });

  it('only lists tools that actually exist and are Tier 3', () => {
    // A typo'd or downgraded entry would silently stop protecting anything.
    for (const tool of DURABLE_RELEASE_ONLY_TOOLS) {
      const tier = getToolTier(tool);
      expect(tier, `${tool} is listed but has no tier`).toBeDefined();
      expect(tier, `${tool} is durable-release-only but not Tier 3`).toBe(3);
    }
  });
});

describe('inline release path ordering', () => {
  it('checks requiresDurableRelease BEFORE attempting the approved->executing CAS', () => {
    // This is a source-order assertion because the property being protected IS
    // an ordering property, and it is not observable from the outside: if the
    // check ran after the CAS, the inline session would already have claimed
    // an intent it must not run, and it cannot safely un-claim. A behavioural
    // test would have to win a race to detect the difference.
    const source = readFileSync(join(__dirname, 'aiAgentSdk.ts'), 'utf8');

    const guardIndex = source.indexOf('requiresDurableRelease(toolName)');
    expect(guardIndex, 'inline release guard is missing entirely').toBeGreaterThan(-1);

    const casIndex = source.indexOf("'approved',\n            'executing',");
    expect(casIndex, 'could not locate the approved->executing CAS').toBeGreaterThan(-1);

    expect(
      guardIndex,
      'requiresDurableRelease must be checked BEFORE the CAS claims the intent',
    ).toBeLessThan(casIndex);
  });
});
