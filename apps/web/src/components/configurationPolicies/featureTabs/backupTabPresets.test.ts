import { describe, it, expect } from 'vitest';
import { describeExclusionPattern } from '@breeze/shared';
import { createOsPresets, createExclusionGroups } from './backupTabPresets';

/**
 * Every exclusion glob this UI ships must be accepted by the API-side validator
 * added in #2473.
 *
 * If a preset or suggestion chip were rejected, EVERY policy save that used it
 * would fail with a validation error — the over-strict catastrophe the issue
 * explicitly warns about, triggered by our own defaults.
 *
 * This deliberately iterates the REAL preset modules rather than a hand-copied
 * list. An earlier version of this test copied the patterns by hand and was
 * already out of sync on day one (it missed `*.swp`), which is exactly the kind
 * of drift a "kept in sync by hand" comment never prevents.
 */
describe('shipped backup exclusion presets are valid in the agent dialect (#2473)', () => {
  const presetPatterns = createOsPresets().flatMap((p) => p.excludes);
  const suggestionPatterns = createExclusionGroups().flatMap((g) =>
    g.items.map((i) => i.pattern),
  );
  const shipped = [...new Set([...presetPatterns, ...suggestionPatterns])];

  it('finds patterns to check (guards against the presets being emptied)', () => {
    expect(presetPatterns.length).toBeGreaterThan(0);
    expect(suggestionPatterns.length).toBeGreaterThan(0);
  });

  it.each(shipped)('accepts %s', (pattern) => {
    const verdict = describeExclusionPattern(pattern);
    expect(verdict.usable, `${pattern} → ${verdict.message ?? ''}`).toBe(true);
  });
});
