import { MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH } from '@breeze/shared';

/**
 * Deliberately generic. A marker naming the variable key would CONFIRM which
 * credential the script emitted, to an audience (`scripts:read`) wider than
 * the script's author — the same leak this exists to prevent, minus the
 * characters.
 */
export const EXACT_REDACTION_MARKER = '[REDACTED]';

/**
 * Build a redactor that removes every literal occurrence of the supplied
 * secret values from a text.
 *
 * Honest scope: this is ACCIDENTAL-LEAK protection, not DLP. It removes a
 * credential a script echoed, logged, or included in an error message. It
 * cannot catch a value the script transformed, base64-encoded, hashed,
 * reversed, or printed one character per line. Treat it as a safety net over
 * careless output, never as a control against a hostile script author — who
 * already holds the credential by definition.
 *
 * Complements `secretRedaction.ts`, which is NAME-based and only fires when a
 * secret sits next to a recognized key name (`token=...`); a bare echoed value
 * survives that layer entirely.
 *
 * Algorithm: collect ALL match ranges of ALL values against the ORIGINAL text,
 * merge overlaps, then rebuild the string in one pass. The naive alternative
 * (`String.replaceAll` per value, longest first) rescans text it has already
 * rewritten, so a value overlapping a previous match produces nested markers
 * and a value that happens to occur inside `[REDACTED]` re-fires. Cost is
 * O(values x text), with no backtracking — `indexOf` on a literal, never a
 * RegExp built from attacker-influenced input.
 */
export function buildExactValueRedactor(
  values: readonly string[],
): (text: string) => string {
  // Values below the floor are dropped rather than redacted: replacing every
  // "ab" would destroy the output while barely protecting anything. Dispatch
  // refuses to ship such a secret at all (scriptSecretEnvelope), so reaching
  // this filter means something upstream already failed — fail readable.
  const needles = [
    ...new Set(
      values.filter(
        (value) =>
          typeof value === 'string' && value.length >= MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH,
      ),
    ),
  ];
  if (needles.length === 0) return (text) => text;

  return (text: string): string => {
    if (!text) return text;

    const ranges: Array<[number, number]> = [];
    for (const needle of needles) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(needle, from);
        if (at === -1) break;
        ranges.push([at, at + needle.length]);
        // Advance past this match: overlapping occurrences of OTHER needles
        // are still found by their own scan, and the merge below collapses
        // anything that touches.
        from = at + needle.length;
      }
    }
    if (ranges.length === 0) return text;

    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      // `start < last[1]` (not `<=`): two ranges that merely ABUT are distinct
      // occurrences and each earns its own marker.
      if (last && start < last[1]) {
        if (end > last[1]) last[1] = end;
      } else {
        merged.push([start, end]);
      }
    }

    let out = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      out += text.slice(cursor, start) + EXACT_REDACTION_MARKER;
      cursor = end;
    }
    return out + text.slice(cursor);
  };
}
