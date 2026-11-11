/**
 * #11395 (W03 T9): PROFILE_PREFIX_TOKENS pins. Each pin is the advertised
 * fixed prefix (system prompt + tool schemas) of a surface under a profile,
 * measured as `auto` will meet it: on a gateway connection, translated to the
 * upstream OpenAI-compatible request (compacted when the exposure says so),
 * bytes / 3 (gateway/openai/adapter.ts estimateInputTokens). A registry,
 * prompt or schema change that moves any pinned prefix by more than 10 %
 * fails here and must re-measure: `auto` picks profiles from these numbers.
 */
import { describe, expect, it } from 'vitest';
import '../aiTools';
import { measureProfilePrefixes, PREFIX_SURFACE_SOURCES } from '../llm/toolCapture/advertisedPrefix';
import { PROFILE_PREFIX_TOKENS, PROFILED_SURFACES } from './toolProfiles';

const fresh = measureProfilePrefixes();
const PROFILES = ['minimal', 'standard', 'full'] as const;

describe('PROFILE_PREFIX_TOKENS (#11395)', () => {
  it('chat minimal ≤ 3,500 and chat standard ≤ 12,000 tokens (plan Budget table)', () => {
    expect(fresh.chat.minimal).toBeLessThanOrEqual(3500);
    expect(fresh.chat.standard).toBeLessThanOrEqual(12000);
  });

  it('profiles are ordered: minimal < standard < full on every measured surface', () => {
    for (const surface of Object.keys(PREFIX_SURFACE_SOURCES) as Array<keyof typeof PREFIX_SURFACE_SOURCES>) {
      const m = fresh[surface];
      expect(m.minimal, surface).toBeLessThan(m.standard);
      expect(m.standard, surface).toBeLessThan(m.full);
    }
  });

  it.each(Object.keys(PREFIX_SURFACE_SOURCES).flatMap((surface) => PROFILES.map((profile) => [surface, profile] as const)))(
    '%s × %s: the pin is within 10 % of a fresh measurement', (surface, profile) => {
      const pinned = PROFILE_PREFIX_TOKENS[surface as keyof typeof PREFIX_SURFACE_SOURCES][profile];
      const measured = fresh[surface as keyof typeof PREFIX_SURFACE_SOURCES][profile];
      expect(measured).toBeGreaterThan(0);
      expect(pinned, `${surface} ${profile}: measured ${measured}`).not.toBeNull();
      expect(Math.abs(pinned! - measured) / measured, `${surface} ${profile}: pinned ${pinned}, measured ${measured}`).toBeLessThanOrEqual(0.10);
    },
  );

  it('an unmeasured surface stays null, so `auto` never constrains it on a guess', () => {
    for (const surface of PROFILED_SURFACES) {
      if (Object.hasOwn(PREFIX_SURFACE_SOURCES, surface)) continue;
      expect(PROFILE_PREFIX_TOKENS[surface]).toEqual({ minimal: null, standard: null, full: null });
    }
  });
});
