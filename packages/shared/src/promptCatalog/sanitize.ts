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
 * 9. A reserved brand name → null (#10325; see PROMPT_RESERVED_BRANDS), checked
 *    on the name both before and after the cap. The same check refuses such a
 *    name when a partner or org is saved (isReservedPromptBrandName).
 *
 * Known limits (by design): a name written entirely in one script's look-alike
 * letters (all-Cyrillic "сіѕсо") is not caught, because single-script Cyrillic
 * and Greek names are legitimate; a brand next to a word outside the qualifier
 * list ("Contoso Microsoft Partner") is kept; and digit look-alikes
 * ("M1crosoft") are not folded. The result is plain text: markup and `{placeholders}` are kept
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

/**
 * Reserved brand names (#10325). A name is reserved when its letters and
 * digits, read without case, diacritics, spaces or punctuation, are exactly a
 * run of these words with at least one brand: "Microsoft", "Windows Security",
 * "Apple Help Desk", "MicrosoftSupport", "Micro soft", "Mícrosoft®",
 * "Microsoft™" (NFKC has already made ™ the letters "TM"). The lists
 * are data: change them here, in agent/internal/promptcatalog/sanitize.go and
 * in the shared fixture's `reservedBrands` (all three are asserted equal).
 */
export const PROMPT_RESERVED_BRANDS: ReadonlyArray<string> = [
  'microsoft', 'windows', 'apple', 'macos', 'icloud', 'google', 'azure',
];

/** Words that may surround a brand and still leave the name reserved. */
export const PROMPT_RESERVED_BRAND_QUALIFIERS: ReadonlyArray<string> = [
  'support', 'security', 'help', 'desk', 'service', 'services', 'team', 'tech',
  'technical', 'technician', 'it', 'customer', 'care', 'center', 'centre', 'update',
  'updates', 'defender', 'account', 'accounts', 'admin', 'official', 'store', '365',
  'inc', 'corp', 'corporation', 'llc', 'ltd', 'the', 'tm', 'sm',
];

const KEY_KEPT = /[\p{L}\p{N}]/u;

/**
 * The matching key: NFD, lower case, then only letters and digits (combining
 * marks, spaces, punctuation and symbols dropped). A non-ASCII letter is kept,
 * so it never matches the ASCII word lists.
 */
function brandKey(s: string): string {
  let key = '';
  for (const ch of s.normalize('NFD').toLowerCase()) {
    if (KEY_KEPT.test(ch)) key += ch;
  }
  return key;
}

/** True when `key` splits wholly into list words, at least one a brand. */
function isReservedKey(key: string): boolean {
  if (key === '') return false;
  // reach[i]: 0 = key[0..i) does not split; 1 = splits, no brand; 2 = splits with a brand.
  const reach = new Array<number>(key.length + 1).fill(0);
  reach[0] = 1;
  for (let i = 0; i < key.length; i++) {
    const here = reach[i]!;
    if (here === 0) continue;
    for (const w of PROMPT_RESERVED_BRANDS) {
      if (key.startsWith(w, i)) reach[i + w.length] = 2;
    }
    for (const w of PROMPT_RESERVED_BRAND_QUALIFIERS) {
      if (key.startsWith(w, i) && here > reach[i + w.length]!) reach[i + w.length] = here;
    }
  }
  return reach[key.length] === 2;
}

/**
 * Steps 1–8. `shown` is the capped name a prompt displays; `full` is the same
 * name before the cap. Null when nothing usable is left.
 */
function cleanName(raw: string): { full: string; shown: string } | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(WHITESPACE_CONTROLS, ' ').replace(STRIPPED, '');
  s = s.normalize('NFKC').replace(STRIPPED, '');
  s = capCombiningMarks(s);
  s = s.replace(WHITESPACE_RUN, ' ').trim();
  if (s === '') return null;
  if (s.split(' ').some(mixesConfusableScripts)) return null;
  const full = s;
  const codePoints = Array.from(s);
  if (codePoints.length > PROMPT_PARTNER_NAME_MAX_CODE_POINTS) {
    s = codePoints.slice(0, PROMPT_PARTNER_NAME_MAX_CODE_POINTS).join('').trim();
  }
  return s === '' ? null : { full, shown: s };
}

/**
 * Step 9 checks both forms: the cap can cut a long brand-only name mid-word
 * ("… Microsoft Supp"), and it can cut the only non-list word off the end of a
 * name, leaving nothing but brand words on screen.
 */
function isReservedName(name: { full: string; shown: string }): boolean {
  return isReservedKey(brandKey(name.full)) || isReservedKey(brandKey(name.shown));
}

/**
 * True when `raw` is a reserved brand name ("Microsoft Support"), which
 * sanitizePromptPartnerName turns into null. Partner and org saves use it to
 * refuse the name with a message, rather than let every device prompt fall
 * back to the generic name. False for a name the sanitizer drops for another
 * reason (empty, mixed scripts).
 */
export function isReservedPromptBrandName(raw: string): boolean {
  const name = cleanName(raw);
  return name !== null && isReservedName(name);
}

export function sanitizePromptPartnerName(raw: string): string | null {
  const name = cleanName(raw);
  if (name === null || isReservedName(name)) return null;
  return name.shown;
}
