import { describe, expect, it } from 'vitest';
import { statusColors } from './orgStatus';

/**
 * Status colour is meaning, and meaning has to survive a theme change: the
 * pills use the app's semantic tokens (success / warning / destructive /
 * muted / primary), never raw palette steps, so `active` stays the same green
 * as every other "healthy" in the product and dark mode needs no per-status
 * override.
 */
describe('orgStatus colours', () => {
  it('use semantic tokens, not raw Tailwind palette steps', () => {
    const rawPalette = /\b(?:emerald|green|blue|amber|yellow|red|orange|indigo|gray|slate|zinc)-\d{2,3}\b/;
    for (const [status, classes] of Object.entries(statusColors)) {
      expect(classes, `${status} pill uses a raw palette colour`).not.toMatch(rawPalette);
      expect(classes, `${status} pill carries no dark-mode override (tokens theme themselves)`).not.toMatch(/\bdark:/);
    }
  });

  it('keeps trial off the brand colour so it never reads as a link', () => {
    expect(statusColors.trial).not.toMatch(/\bprimary\b/);
  });
});
