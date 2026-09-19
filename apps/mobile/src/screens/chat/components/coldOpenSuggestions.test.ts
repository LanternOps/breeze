import { describe, it, expect } from 'vitest';

import { COLD_OPEN_SUGGESTIONS } from './coldOpenSuggestions';

/**
 * #5362 — "Show fleet status" was a near-verbatim match for the AI tool then
 * named `get_fleet_status` (the deployment-invite funnel, now
 * `get_invite_funnel`). The tool NAME is what wins model tool-selection, so the
 * chip routed to the funnel tool and answered "your fleet is empty — no devices
 * have been enrolled yet" on a tenant showing 36 online / 15 offline in the
 * app's own strip directly above it.
 *
 * The API-side rename is the other half of the fix; this half keeps the chip
 * copy from drifting back into tool-identifier phrasing.
 */
describe('cold-open chip suggestions (#5362)', () => {
  it('never phrases a chip as "fleet status"', () => {
    for (const suggestion of COLD_OPEN_SUGGESTIONS) {
      expect(
        suggestion.toLowerCase(),
        `"${suggestion}" name-matches the invite-funnel tool — see #5362`,
      ).not.toContain('fleet status');
    }
  });

  it('still offers a fleet question, phrased as a user would ask it', () => {
    const fleetChips = COLD_OPEN_SUGGESTIONS.filter((s) => /fleet/i.test(s));
    expect(fleetChips).toHaveLength(1);
    // A question routes on intent (device counts / online-offline) rather than
    // matching a tool identifier, so it reaches query_devices / get_fleet_health.
    expect(fleetChips[0]).toMatch(/\?$/);
  });

  it('offers a non-empty, duplicate-free set of chips', () => {
    expect(COLD_OPEN_SUGGESTIONS.length).toBeGreaterThan(0);
    expect(new Set(COLD_OPEN_SUGGESTIONS).size).toBe(COLD_OPEN_SUGGESTIONS.length);
    for (const suggestion of COLD_OPEN_SUGGESTIONS) {
      expect(suggestion.trim()).toBe(suggestion);
      expect(suggestion.length).toBeGreaterThan(0);
    }
  });
});
