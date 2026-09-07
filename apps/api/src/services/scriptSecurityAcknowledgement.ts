import {
  STRICT_SCRIPT_PATTERN_DESCRIPTIONS,
  detectStrictScriptPatterns,
} from '@breeze/shared';

/**
 * Server-side resolution of a script's STRICT-level security acknowledgements
 * (#5129).
 *
 * The agent refuses to run a script matching a Strict danger pattern unless
 * the dispatch payload carries that pattern's DESCRIPTION in the acknowledged
 * set. This module decides what that stored set is on every save.
 *
 * The one rule that makes the whole design safe:
 *
 *   stored = (what the caller asked for) ∩ (what the content actually matches)
 *
 * Both halves matter.
 *
 * Intersecting with the live match set is what stops an admin from
 * pre-acknowledging the entire vocabulary once and permanently disarming
 * Strict checking for that script. It is also what makes an EDIT safe: a save
 * that introduces a credential-dumping pattern produces a match the caller
 * never acknowledged, so it is not stored, and the agent still blocks it —
 * while the HKLM approval that was already there keeps working.
 *
 * Carrying the existing set forward when the caller omits the field is what
 * stops an ordinary metadata edit (rename, timeout change) from silently
 * revoking an approval — a PATCH-shaped update must not mean "acknowledge
 * nothing".
 *
 * Nothing here is a permission check. Both callers already sit behind
 * `SCRIPTS_WRITE` + MFA; acknowledging a risk is deliberately not a new
 * permission, because anyone who can rewrite the script body can already make
 * it do whatever the pattern describes.
 */

/** Cap on a submitted acknowledgement array, well above the vocabulary size. */
export const MAX_ACKNOWLEDGED_SECURITY_PATTERNS = 64;

export type ScriptSecurityAcknowledgementResolution = {
  /** The set to persist on the script row, ordered by the agent's pattern order. */
  acknowledged: string[];
  /** Every Strict description the content currently matches. */
  matched: string[];
  /** Matched patterns with no acknowledgement — these still block at run time. */
  unacknowledged: string[];
  /** Descriptions acknowledged by this save that were not acknowledged before. */
  added: string[];
  /** Descriptions that were acknowledged before and are not any more. */
  removed: string[];
  /** Did this save change the stored set at all? */
  changed: boolean;
};

function normalize(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Is every entry a description the agent could actually produce?
 *
 * Enforced at the route boundary so a typo or a probe is a 400 rather than a
 * silently-dropped acknowledgement the admin believes they granted. Note this
 * is vocabulary membership only — whether the pattern matches THIS content is
 * decided by `resolveScriptSecurityAcknowledgement`, which drops non-matching
 * entries rather than rejecting them (an edit that removes a risky line must
 * not 400 on the acknowledgement it leaves behind).
 */
export function unknownSecurityPatternDescriptions(values: readonly string[]): string[] {
  const vocabulary = new Set(STRICT_SCRIPT_PATTERN_DESCRIPTIONS);
  return normalize(values).filter((value) => !vocabulary.has(value));
}

export function resolveScriptSecurityAcknowledgement(input: {
  /** The script content as it will be stored after this save. */
  content: string;
  /**
   * What the caller explicitly acknowledged. `undefined` means the caller did
   * not touch the field (a metadata-only edit) and the existing set carries
   * forward; an empty array is an explicit "acknowledge nothing".
   */
  submitted?: readonly string[] | null;
  /** What is currently stored on the script row. */
  existing?: readonly string[] | null;
}): ScriptSecurityAcknowledgementResolution {
  const matched = detectStrictScriptPatterns(input.content);

  const previous = normalize(input.existing);
  const previousSet = new Set(previous);

  // `undefined` (field absent) carries the existing set forward. `null` and
  // `[]` are both an explicit revoke-everything.
  const requested = input.submitted === undefined ? previous : normalize(input.submitted);
  const requestedSet = new Set(requested);

  // Ordered by the agent's own pattern order so the stored value is stable
  // across saves and diffs cleanly in an audit trail.
  const acknowledged = matched.filter((description) => requestedSet.has(description));
  const acknowledgedSet = new Set(acknowledged);

  const added = acknowledged.filter((description) => !previousSet.has(description));
  const removed = previous.filter((description) => !acknowledgedSet.has(description));

  return {
    acknowledged,
    matched,
    unacknowledged: matched.filter((description) => !acknowledgedSet.has(description)),
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}

/**
 * The acknowledgement columns to write for a resolution, or `null` when the
 * save leaves the acknowledgement untouched and the columns must not move.
 *
 * `securityAcknowledgedBy` / `At` record the LAST person to grant an
 * acknowledgement, so they are only stamped when something was actually
 * granted. A save that only revokes clears them along with the set if nothing
 * is left, and otherwise leaves the earlier grant's attribution standing —
 * revoking is not an act of approval and must not read as one.
 */
export type ScriptSecurityAcknowledgementColumns = {
  acknowledgedSecurityPatterns: string[];
  securityAcknowledgedBy?: string | null;
  securityAcknowledgedAt?: Date | null;
};

export function scriptSecurityAcknowledgementColumns(
  resolution: ScriptSecurityAcknowledgementResolution,
  actorId: string,
  now: Date = new Date(),
): ScriptSecurityAcknowledgementColumns | null {
  if (!resolution.changed) return null;

  if (resolution.acknowledged.length === 0) {
    return {
      acknowledgedSecurityPatterns: [],
      securityAcknowledgedBy: null,
      securityAcknowledgedAt: null,
    };
  }

  if (resolution.added.length === 0) {
    // Only revocations, but something is still acknowledged: keep the set
    // current and leave the earlier grant's attribution standing. The two
    // attribution keys are OMITTED, not set to undefined — a Drizzle `.set()`
    // treats a present `undefined` differently from an absent key.
    return { acknowledgedSecurityPatterns: resolution.acknowledged };
  }

  return {
    acknowledgedSecurityPatterns: resolution.acknowledged,
    securityAcknowledgedBy: actorId,
    securityAcknowledgedAt: now,
  };
}

/**
 * The acknowledgement columns for a path that replaces a script's content
 * WITHOUT a human reviewing the result: bundle import in `new-version` mode,
 * and the system-script-library sync.
 *
 * These always clear the acknowledgement, and deliberately do NOT carry it
 * forward the way an interactive save does. The carry-forward rule on
 * `PUT /scripts/:id` is safe because a person is looking at the editor, sees
 * the security-review section for the body they are saving, and re-submits the
 * approval. A bundle is a FILE — its own module docblock calls it untrusted
 * input regardless of who uploaded it — and nobody reads the incoming body.
 *
 * Without this, an entry named after an existing approved script replaces its
 * content wholesale and inherits the approval: exactly the "a later edit
 * inherits the acknowledgement silently" failure the description-set design
 * exists to prevent, reached through a different door. Re-acknowledging is a
 * trip back into the script editor, which is the point.
 */
export function clearedScriptSecurityAcknowledgementColumns(): Required<ScriptSecurityAcknowledgementColumns> {
  return {
    acknowledgedSecurityPatterns: [],
    securityAcknowledgedBy: null,
    securityAcknowledgedAt: null,
  };
}
