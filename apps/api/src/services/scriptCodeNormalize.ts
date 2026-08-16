/**
 * Normalize non-ASCII Unicode in AI-generated script code to ASCII.
 *
 * LLMs emit two families of offender: typographic punctuation (curly quotes,
 * em/en dashes, ellipses, non-breaking and zero-width spaces) and decorative
 * status glyphs in progress output (check marks, crosses, warning signs,
 * arrows, bullets, emoji). In syntax positions the punctuation breaks
 * bash/python outright. On Windows the failure is broader and worse:
 * PowerShell 5.1 decodes a BOM-less .ps1 as the system ANSI codepage, and each
 * byte of a multi-byte sequence then decodes as its own CP1252 char. Bytes
 * 0x91-0x94 are the curly quotes, which PowerShell honours as genuine string
 * delimiters, so any character carrying one silently closes the string it sits
 * in and the parse cascades into "Unexpected token" / "missing string
 * terminator" errors pointing far from the real position. U+2713 CHECK MARK
 * (E2 9C 93, the 0x93 landing on U+201C) is the observed real-world case: a
 * Write-Host progress line with a check mark makes the whole file unparseable.
 *
 * The Go agent stamps a UTF-8 BOM on .ps1 files (internal/executor/shell.go
 * WriteScriptFile), which fixes the decode at the source, but that fix only
 * reaches a device once its agent updates. This pass is the server-side half:
 * it takes effect the moment the code is applied to the editor, on every
 * agent version, so keep it able to stand alone.
 *
 * Replacements apply everywhere, including inside string contents -- an
 * intentional trade-off: a glyph in output text is cosmetic, while the same
 * glyph in a delimiter position is always a bug. Status glyphs are
 * transliterated ("[OK]") rather than deleted so log output stays readable;
 * purely decorative blocks are deleted. Letters, accents and CJK pass through
 * untouched -- they are legitimate content, and none of them can act as a
 * delimiter even when mis-decoded.
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

  // Status glyphs. These are what the model actually reaches for when writing
  // progress output ("Write-Host \u2713 Download completed"), and they are the
  // characters observed in every real parse failure -- U+2713 encodes as
  // E2 9C 93, whose trailing 0x93 lands on U+201C in CP1252, and PowerShell
  // honours U+201C as a real double-quote delimiter, so the string terminates
  // mid-line. Transliterated rather than deleted to keep the output readable.
  [/[\u2713\u2714\u2705\u2611]/g, '[OK]'],
  [/[\u2717\u2718\u2716\u274C\u2612]/g, '[X]'],
  [/[\u26A0\u26D4\u2757\u2755]/g, '[!]'],
  // Arrows and bullets that carry meaning in progress/log lines
  [/[\u2192\u27A1\u21D2]/g, '->'],
  [/[\u2190\u21D0]/g, '<-'],
  [/[\u2022\u2023\u25CF\u25AA\u25A0]/g, '*'],

  // Remaining arrows, technical marks, shapes, dingbats and pictographs --
  // decorative only, never meaningful in script syntax, so delete rather than
  // transliterate. Runs AFTER the specific maps above so those keep their
  // ASCII spellings. Whole blocks are swept rather than the individual glyphs
  // seen in the wild because the hazard is byte-level, not glyph-level: ANY
  // byte of a multi-byte sequence lands on its own CP1252 char, and 0x91-0x94
  // are the curly quotes PowerShell honours as string delimiters. U+2713
  // (E2 9C 93) and U+2500 (E2 94 80) both carry one. Letters, accents and CJK
  // stay -- none of their bytes fall in that range.
  [/[\u2190-\u21FF\u2300-\u23FF\u2500-\u27BF\u2B00-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]/gu, ''],

  // Zero-width, word-joiner, invisible-operator and soft-hyphen characters,
  // plus stray BOMs -- delete outright.
  [/[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g, ''],
];

export function normalizeScriptCode(code: string): string {
  let result = code;
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
