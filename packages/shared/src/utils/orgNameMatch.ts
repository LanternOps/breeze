/**
 * Corporate-name normalization for matching an outside customer record (a Pax8
 * company or a backup or EDR tenant today; UniFi sites next) to a Breeze organization.
 *
 * These keys only ever produce SUGGESTIONS. A person confirms a match before it
 * is written, so changing the suffix list changes suggestions, never stored
 * mappings. The web uses the keys only to explain a match ("matched on acme").
 *
 * Accounting's `normalizeMatchValue` is deliberately separate: it also
 * normalizes emails and SKUs, where stripping a corporate suffix would be wrong.
 */

/**
 * Trailing legal-entity designators, each a space-separated token sequence as it
 * reads AFTER punctuation became spaces (so `L.L.C.` is `'l l c'`).
 */
export const ORG_NAME_LEGAL_SUFFIXES: readonly string[] = Object.freeze([
  'inc', 'incorporated', 'llc', 'l l c', 'lc', 'ltd', 'limited', 'corp', 'corporation', 'co',
  'company', 'plc', 'pllc', 'pc', 'lp', 'llp', 'gmbh', 'ag', 'kg', 'ug', 'sa', 'sas', 'sarl',
  'srl', 'spa', 'bv', 'nv', 'pty', 'pte', 'oy', 'ab', 'as', 'aps', 'kk', 'pty ltd',
]);

/** Token sequences, longest first, so `pty ltd` strips before `ltd`. */
const SUFFIX_TOKENS: readonly (readonly string[])[] = [...ORG_NAME_LEGAL_SUFFIXES]
  .map((suffix) => suffix.split(' '))
  .sort((a, b) => b.length - a.length);

const COMBINING_MARKS = /\p{M}+/gu;
// ASCII apostrophe, right single quotation mark, modifier letter apostrophe.
// U+02BC is a letter (Lm), so the non-letter rule below would keep it.
const APOSTROPHES = /['\u2019\u02BC]/g;
const AMPERSAND_OR_PLUS = /[&+]/g;
const NON_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

/**
 * The `exact` match tier's key: trim + lowercase, the rule backup and EDR name
 * suggestions used before the normalized tier existed. The tier compares on this,
 * so `Acme Inc` matches the org named `Acme Inc` even when `Acme LLC` exists.
 */
export function exactOrgMatchKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

function endsWithTokens(tokens: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > tokens.length) return false;
  const offset = tokens.length - suffix.length;
  return suffix.every((token, i) => tokens[offset + i] === token);
}

/**
 * The `normalized` match tier's key. Ignores case, accents, punctuation (`&` and
 * `+` read as "and"), one leading "the" and trailing corporate suffixes
 * (`Acme, Inc.` → `acme`). It never strips a name to nothing
 * (`Company Inc` → `company`, `Inc.` → `inc`). Returns `null` when nothing
 * letter- or digit-like is left.
 */
export function normalizeOrgMatchName(value: string | null | undefined): string | null {
  if (!value) return null;
  const folded = value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLocaleLowerCase('en-US')
    .replace(AMPERSAND_OR_PLUS, ' and ')
    .replace(APOSTROPHES, '')
    .replace(NON_LETTER_OR_DIGIT, ' ')
    .trim();
  if (folded.length === 0) return null;

  const tokens = folded.split(' ');
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();

  let stripped = true;
  while (stripped && tokens.length > 1) {
    stripped = false;
    for (const suffix of SUFFIX_TOKENS) {
      // Never strip to empty: the name must keep at least one token.
      if (suffix.length < tokens.length && endsWithTokens(tokens, suffix)) {
        tokens.splice(tokens.length - suffix.length, suffix.length);
        stripped = true;
        break;
      }
    }
  }
  return tokens.join(' ');
}

/**
 * Conservative key for comparing site names (for UniFi site → Breeze site). Site
 * names are not company names, so suffixes and punctuation are kept.
 */
export function siteNameMatchKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  return key.length > 0 ? key : null;
}
