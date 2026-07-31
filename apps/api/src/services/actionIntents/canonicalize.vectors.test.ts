/**
 * The API half of the cross-package canonicalizer contract.
 *
 * `canonicalize.test.ts` next door still covers behaviour. This file covers *agreement*:
 * it runs the frozen corpus through the API's own import path, so if anything ever
 * shadows, wraps, or re-implements the canonicalizer on this side, the stored
 * `action_intents.argument_digest` values stop matching and this fails.
 *
 * The same corpus is executed inside `@breeze/shared` and — once it exists — by the M365
 * communications executor. Expectations are frozen constants and are never recomputed;
 * see the header of `vectors.ts` for why that matters.
 */
import { describe, it, expect } from 'vitest';
import { CANONICALIZATION_VECTORS } from '@breeze/shared/canonicalize/vectors';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

describe('canonicalizer conformance (API import path)', () => {
  it('runs a non-empty corpus', () => {
    expect(CANONICALIZATION_VECTORS.length).toBeGreaterThan(10);
  });

  it.each(CANONICALIZATION_VECTORS.map((v) => [v.name, v] as const))(
    'vector %s produces the frozen digest',
    (_name, vector) => {
      const canonical = canonicalizeArguments(vector.input);
      if (vector.canonical !== undefined) expect(canonical).toBe(vector.canonical);
      expect(computeArgumentDigest(canonical)).toBe(vector.digest);
    }
  );
});
