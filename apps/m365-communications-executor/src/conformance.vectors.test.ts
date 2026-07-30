import { describe, expect, it } from 'vitest';
import { CANONICALIZATION_VECTORS } from '@breeze/shared/canonicalize/vectors';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import { COMMS_PLAN_VECTORS } from '@breeze/shared/m365/commsPlanVectors';
import { buildCommsSendEffect } from '@breeze/shared/m365';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from '@breeze/shared/m365/commsDigests';

/**
 * Cross-package agreement. The API runs these corpora through its own import
 * path (canonicalize.vectors.test.ts); this file makes the executor the second
 * consumer. If anything ever shadows, wraps, or re-implements the canonicalizer
 * or the digest pair on this side, the digests the API stored stop matching and
 * this fails — which is the entire content-binding guarantee (design §5.2,
 * risk #4). Expectations are frozen constants, never recomputed here.
 */
describe('canonicalization vectors (executor side)', () => {
  expect(CANONICALIZATION_VECTORS.length).toBeGreaterThan(10);
  for (const vector of CANONICALIZATION_VECTORS) {
    it(vector.name, () => {
      const canonical = canonicalizeArguments(vector.input);
      if (vector.canonical !== undefined) expect(canonical).toBe(vector.canonical);
      expect(computeArgumentDigest(canonical)).toBe(vector.digest);
    });
  }
});

describe('comms plan vectors (executor side)', () => {
  expect(COMMS_PLAN_VECTORS.length).toBeGreaterThan(5);
  for (const vector of COMMS_PLAN_VECTORS) {
    it(vector.name, () => {
      const envelope = buildCommsSendEffect(vector.input);
      expect(computeCommsEnvelopeDigest(envelope)).toBe(vector.envelopeDigest);
      expect(computeCommsPlanDigest(envelope)).toBe(vector.planDigest);
    });
  }
});
