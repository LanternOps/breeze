// packages/shared/src/canonicalize/effectSet.vectors.test.ts
/**
 * Agreement, not behaviour. `effectSet.test.ts` next door covers behaviour;
 * this runs the FROZEN corpus so that if anything ever shadows, wraps or
 * re-implements the effect-set envelope, every stored
 * `ai_operator_plan_approvals.effect_set_digest` stops matching and this fails.
 *
 * Expectations are frozen constants and are NEVER recomputed — see the header
 * of `vectors.ts` for why that is the whole point.
 */
import { describe, expect, it } from 'vitest';
import { EFFECT_SET_VECTORS } from './vectors';
import { canonicalizeEffectSet, computeEffectSetDigest } from './effectSet';

describe('effect-set envelope conformance', () => {
  it('runs a non-empty corpus', () => {
    expect(EFFECT_SET_VECTORS.length).toBeGreaterThanOrEqual(4);
  });

  it('carries no unresolved placeholder', () => {
    for (const v of EFFECT_SET_VECTORS) {
      expect(v.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(v.canonical.startsWith('{')).toBe(true);
    }
  });

  it.each(EFFECT_SET_VECTORS.map((v) => [v.name, v] as const))(
    'vector %s produces the frozen canonical form and digest',
    (_name, vector) => {
      expect(canonicalizeEffectSet(vector.input)).toBe(vector.canonical);
      expect(computeEffectSetDigest(vector.input)).toBe(vector.digest);
    },
  );

  it('the two reorder vectors have different digests', () => {
    const a = EFFECT_SET_VECTORS.find((v) => v.name === 'two-provider-ordered-plan')!;
    const b = EFFECT_SET_VECTORS.find((v) => v.name === 'two-provider-plan-reordered')!;
    expect(b.digest).not.toBe(a.digest);
  });
});
