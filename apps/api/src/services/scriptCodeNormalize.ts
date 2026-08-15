/**
 * Normalize typographic Unicode punctuation in AI-generated script code.
 *
 * LLMs occasionally emit curly quotes, em/en dashes, ellipses, and
 * non-breaking/zero-width characters inside script code. In syntax positions
 * these break bash/python outright, and Windows PowerShell 5.1 mis-decodes
 * them entirely in a BOM-less ANSI read, producing cascading parse errors
 * ("Unexpected token", "missing string terminator"). The Go agent stamps a
 * UTF-8 BOM on .ps1 files (internal/executor/shell.go WriteScriptFile), but
 * code should be plain ASCII punctuation regardless.
 *
 * Replacements apply everywhere, including inside string contents -- an
 * intentional trade-off: typographic punctuation in script output text is
 * cosmetic, while in a delimiter position it is always a bug. Otherwise
 * deliberately conservative: only unambiguous typographic substitutions for
 * ASCII are mapped; everything else (accented letters, CJK, symbols) passes
 * through untouched.
 */

const TYPOGRAPHIC_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  // Curly single quotes / apostrophes and prime
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  // Curly double quotes and double prime
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  // Hyphen variants, en/em/horizontal-bar dashes, and the minus sign
  [/[\u2010-\u2015\u2212]/g, '-'],
  // Horizontal ellipsis
  [/\u2026/g, '...'],
  // Non-breaking and fixed-width spaces: NBSP, figure space, narrow NBSP
  [/[\u00A0\u2007\u202F]/g, ' '],
  // Zero-width characters and stray BOMs -- delete outright
  [/[\u200B\u200C\u200D\uFEFF]/g, ''],
];

export function normalizeScriptCode(code: string): string {
  let result = code;
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
