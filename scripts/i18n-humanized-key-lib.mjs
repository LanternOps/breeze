// Shared detection logic for the #2649 "humanized key placeholder" i18n bug
// (see scripts/i18n-humanized-key-scan.mjs, scripts/i18n-recover-original-copy.mjs,
// and apps/web/src/locales/humanizedKeyRegression.test.ts — all three consume this
// module so the heuristic can't silently drift between the scanner and the test
// that guards against regressions).
//
// The #2340 extraction produced humanized placeholders in (at least) two casing
// styles — confirmed by example: `viewerDescription` -> "Viewer Description"
// (title case, every word capitalized) is the literal example from #2649, while
// many other keys ended up as sentence case ("Viewer description", one
// capital). Both must be checked or the detector misses half its own target.

/** "viewerDescription" -> "Viewer description" (only the first word capitalized) */
export function humanizeSentenceCase(leaf) {
  const words = splitWords(leaf);
  if (words.length === 0) return '';
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? capitalize(lower) : lower;
    })
    .join(' ');
}

/** "viewerDescription" -> "Viewer Description" (every word capitalized) */
export function humanizeTitleCase(leaf) {
  const words = splitWords(leaf);
  return words.map((w) => capitalize(w.toLowerCase())).join(' ');
}

/** Number of words in a camelCase / snake / kebab key leaf ("sentToAgent" -> 3). */
export function leafWordCount(leaf) {
  return splitWords(leaf).length;
}

function splitWords(leaf) {
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

function capitalize(lower) {
  return lower.length === 0 ? lower : lower[0].toUpperCase() + lower.slice(1);
}

/**
 * True when `value` is nothing but the humanized rendering of `leaf` — in
 * either casing style, optionally behind a "Failed to " prefix (the
 * errors.* namespace pattern). Single-word leaves are excluded: too noisy
 * to judge reliably (a one-word key legitimately IS its own label most of
 * the time).
 */
export function isHumanizedKeyPlaceholder(leaf, value) {
  const words = splitWords(leaf);
  if (words.length < 2) return false;

  const sentence = humanizeSentenceCase(leaf);
  const title = humanizeTitleCase(leaf);
  const withoutFailedTo = value.startsWith('Failed to ') ? value.slice('Failed to '.length) : null;

  if (value === sentence || value === title) return true;
  if (withoutFailedTo !== null) {
    const lower = withoutFailedTo.toLowerCase();
    if (lower === sentence.toLowerCase() || lower === title.toLowerCase()) return true;
  }
  return false;
}
