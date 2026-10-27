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
 *    systems render as vendor logos), surrogates (Cs) and U+FFFD.
 * 3. NFKC, which folds fullwidth, mathematical and other compatibility
 *    look-alikes ("Ｍｉｃｒｏｓｏｆｔ", "𝐖𝐢𝐧𝐝𝐨𝐰𝐬") to the plain letters they imitate.
 * 4. Collapse whitespace runs to one space and trim.
 * 5. A word mixing Latin, Cyrillic and/or Greek letters (a homoglyph spoof such
 *    as "Місrosoft" with Cyrillic М/і/с) rejects the whole name.
 * 6. Cap at 120 code points, trim again.
 * 7. Empty → null: the renderer shows the localized generic name.
 *
 * The result is plain text: markup and `{placeholders}` are kept verbatim and
 * must never be interpreted by a renderer.
 */
export const PROMPT_PARTNER_NAME_MAX_CODE_POINTS = 120;

const WHITESPACE_CONTROLS = /[\t\n\u000B\f\r\u0085]/g;
const STRIPPED = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}�]/gu;
const WHITESPACE_RUN = /[\p{Z}\t\n\u000B\f\r]+/gu;

const SCRIPTS: ReadonlyArray<RegExp> = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

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

export function sanitizePromptPartnerName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(WHITESPACE_CONTROLS, ' ').replace(STRIPPED, '');
  s = s.normalize('NFKC').replace(STRIPPED, '');
  s = s.replace(WHITESPACE_RUN, ' ').trim();
  if (s === '') return null;
  if (s.split(' ').some(mixesConfusableScripts)) return null;
  const codePoints = Array.from(s);
  if (codePoints.length > PROMPT_PARTNER_NAME_MAX_CODE_POINTS) {
    s = codePoints.slice(0, PROMPT_PARTNER_NAME_MAX_CODE_POINTS).join('').trim();
  }
  return s === '' ? null : s;
}
