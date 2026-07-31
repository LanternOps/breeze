/**
 * The canonicalizer moved to `@breeze/shared/canonicalize` so that processes outside the
 * API — the M365 communications executor, which recomputes an approval digest before it
 * touches any credential — agree on the bytes rather than each having their own copy.
 *
 * This file stays as a re-export so no call site changed in the move. Do not reimplement
 * anything here: a second implementation turns every digest comparison into a check that
 * an implementation agrees with itself. `@breeze/shared/canonicalize/vectors` is the
 * frozen corpus that makes such drift fail, and `canonicalize.vectors.test.ts` runs it
 * through this import path.
 */
export { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
