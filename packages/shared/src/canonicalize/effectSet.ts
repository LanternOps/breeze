/**
 * The effect-set digest (Recipe Library spec §6.4).
 *
 * ONE canonicalizer for the whole approval chain. This module does NOT hash
 * anything itself: it builds a versioned envelope and hands it to
 * `canonicalizeArguments` / `computeArgumentDigest` — the same two functions
 * `action_intents.argument_digest` is computed with
 * (`services/actionIntents/canonicalize.ts` re-exports them). A second hasher
 * here would turn every downstream digest comparison into a self-consistency
 * check, which is the exact failure `vectors.ts`'s header was written to
 * prevent.
 *
 * WHY AN ENVELOPE. `canonicalizeArguments` takes a `Record<string, unknown>`,
 * and the thing being sealed is an ORDERED ARRAY. The canonicalizer sorts
 * object keys and never reorders arrays, so wrapping the list in an object
 * preserves the §6.3 safety ordering (auto-reply first, disable/suspend last)
 * inside a structure the shipped function already handles.
 *
 * WHY taskId AND planRevision ARE INSIDE THE SEAL. Without them, an approver
 * who signed off on a nine-effect plan for Dana would have signed a digest
 * that also validates for an identical plan on a different task, or for the
 * same task after the plan was revised. The unit of pinning is the set ON THIS
 * TASK AT THIS REVISION.
 *
 * CHANGING THE ENVELOPE IS A BREAKING CHANGE. A stored `effect_set_digest`
 * was computed under these bytes; altering the shape invalidates every
 * approved-but-undispatched plan. Bump `EFFECT_SET_DIGEST_ENVELOPE_VERSION`
 * and add vectors, never edit the existing ones.
 */

import { canonicalizeArguments, computeArgumentDigest } from './index';

/** Envelope shape version. Inside the seal, so v1 and v2 can never collide. */
export const EFFECT_SET_DIGEST_ENVELOPE_VERSION = 1;

/**
 * The digestible projection of `PlannedEffect`
 * (`apps/api/src/services/aiOperator/recipes/types.ts`, wave E1).
 *
 * Restated here rather than imported because `@breeze/shared` may not import
 * `apps/api`. `planApproval.ts` maps one to the other in a single function, and
 * `planApproval.test.ts` pins that the field lists agree.
 */
export interface PlannedEffectForDigest {
  ordinal: number;
  toolName: string;
  provider: 'breeze' | 'm365' | 'google';
  targetId: string | null;
  accountExternalId: string | null;
  /**
   * 64-char lowercase hex SHA-256 of this effect's canonical arguments, i.e. the
   * value `action_intents.argument_digest` carries. The digest is recomputed at
   * release from stored effect ROWS, which keep only this digest, so the seal
   * covers the digest rather than the raw arguments.
   */
  argumentDigest: string;
}

export interface EffectSetDigestInput {
  taskId: string;
  planRevision: number;
  effects: readonly PlannedEffectForDigest[];
}

function assertWellFormed(effects: readonly PlannedEffectForDigest[]): void {
  if (effects.length === 0) {
    throw new Error('effect set must contain at least one effect');
  }
  // Ordinals are the membership key at release. A gap or a repeat would let two
  // different effects claim the same slot in the approved set, so this is a
  // structural refusal rather than a normalization.
  for (let i = 0; i < effects.length; i += 1) {
    if (effects[i]!.ordinal !== i) {
      throw new Error(
        `effect set ordinals must be contiguous and ascending from 0; index ${i} has ordinal ${effects[i]!.ordinal}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(effects[i]!.argumentDigest)) {
      throw new Error(
        `effect at index ${i} has an invalid argumentDigest; expected 64 lowercase hex characters (canonicalize the arguments first)`,
      );
    }
  }
}

export function canonicalizeEffectSet(input: EffectSetDigestInput): string {
  assertWellFormed(input.effects);
  return canonicalizeArguments({
    v: EFFECT_SET_DIGEST_ENVELOPE_VERSION,
    taskId: input.taskId,
    planRevision: input.planRevision,
    // Each effect is projected field-by-field rather than spread, so a field
    // added to `PlannedEffect` by a later wave cannot silently enter the seal
    // (which would invalidate every live approval on deploy) without an
    // envelope version bump and new vectors.
    effects: input.effects.map((e) => ({
      ordinal: e.ordinal,
      toolName: e.toolName,
      provider: e.provider,
      targetId: e.targetId,
      accountExternalId: e.accountExternalId,
      argumentDigest: e.argumentDigest,
    })),
  });
}

export function computeEffectSetDigest(input: EffectSetDigestInput): string {
  return computeArgumentDigest(canonicalizeEffectSet(input));
}
