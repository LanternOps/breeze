/**
 * Sanitize the MSP name shown on every device prompt ("who is asking").
 *
 * A spoofing control, not cosmetics: the name sits above Breeze-owned copy on
 * consent, elevation and restart prompts. Mirrored by
 * promptcatalog.SanitizeIdentityName (Go) and run by Breeze Assist; all three
 * are pinned by fixtures/prompt-catalog/identity-name-sanitize.json.
 *
 * No imports on purpose: Breeze Assist imports this file through a path alias.
 *
 * Steps, in order:
 * 1. Whitespace controls (TAB LF VT FF CR, U+0085) become a space.
 * 2. Strip every other control (Cc), every format character (Cf: bidi
 *    embeddings/overrides/isolates/marks, zero-width space/joiners, word joiner,
 *    BOM, soft hyphen, tag characters), private-use code points (Co, which some
 *    systems render as vendor logos), surrogates (Cs), U+FFFD, and letters that
 *    render blank (Hangul fillers U+115F/U+1160/U+3164, Braille blank U+2800,
 *    Mongolian vowel separator U+180E).
 * 3. NFKC, which folds fullwidth, mathematical and other compatibility
 *    look-alikes ("Ｍｉｃｒｏｓｏｆｔ", "𝐖𝐢𝐧𝐝𝐨𝐰𝐬") to the plain letters they imitate;
 *    then step 2 again, because NFKC can produce a blank (U+FFA0 → U+1160).
 * 4. At most 2 consecutive combining marks (Mn/Me) per letter, so stacked marks
 *    cannot paint over the copy around the name.
 * 5. Collapse whitespace runs to one space and trim.
 * 6. A word mixing letters of two confusable scripts (Latin, Cyrillic, Greek,
 *    Armenian, Cherokee, Coptic), such as "Місrosoft" with Cyrillic М/і/с,
 *    rejects the whole name.
 * 7. Cap at 120 code points, trim again.
 * 8. Empty → null: the renderer shows the localized generic name.
 *
 * Known limits (by design): a name written entirely in one script's look-alike
 * letters (all-Cyrillic "сіѕсо") is not caught, because single-script Cyrillic
 * and Greek names are legitimate; and a plain brand word ("Microsoft") is not
 * blocked. The result is plain text: markup and `{placeholders}` are kept
 * verbatim and must never be interpreted. A renderer that embeds the name in
 * running text must bidi-isolate it (FSI…PDI or `<bdi>`), since a right-to-left
 * name keeps its strong RTL letters.
 */
export const PROMPT_PARTNER_NAME_MAX_CODE_POINTS = 120;

/** Consecutive combining marks kept after one base character. */
export const PROMPT_PARTNER_NAME_MAX_MARKS = 2;

const WHITESPACE_CONTROLS = /[\t\n\u000B\f\r\u0085]/g;
const STRIPPED = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}�ᅟᅠㅤ⠀᠎]/gu;
const WHITESPACE_RUN = /[\p{Z}\t\n\u000B\f\r]+/gu;
const MARK = /[\p{Mn}\p{Me}]/u;

const SCRIPTS: ReadonlyArray<RegExp> = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Cherokee}/u,
  /\p{Script=Coptic}/u,
];

function mixesConfusableScripts(word: string): boolean {
  let seen = -1;
  for (const ch of word) {
    for (let i = 0; i < SCRIPTS.length; i++) {
      if (SCRIPTS[i]!.test(ch)) {
        if (seen >= 0 && seen !== i) return true;
        seen = i;
        break;
      }
    }
  }
  return false;
}

function capCombiningMarks(s: string): string {
  let out = '';
  let run = 0;
  for (const ch of s) {
    if (MARK.test(ch)) {
      run++;
      if (run > PROMPT_PARTNER_NAME_MAX_MARKS) continue;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

export function sanitizePromptPartnerName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(WHITESPACE_CONTROLS, ' ').replace(STRIPPED, '');
  s = s.normalize('NFKC').replace(STRIPPED, '');
  s = capCombiningMarks(s);
  s = s.replace(WHITESPACE_RUN, ' ').trim();
  if (s === '') return null;
  if (s.split(' ').some(mixesConfusableScripts)) return null;
  const codePoints = Array.from(s);
  if (codePoints.length > PROMPT_PARTNER_NAME_MAX_CODE_POINTS) {
    s = codePoints.slice(0, PROMPT_PARTNER_NAME_MAX_CODE_POINTS).join('').trim();
  }
  return s === '' ? null : s;
}
