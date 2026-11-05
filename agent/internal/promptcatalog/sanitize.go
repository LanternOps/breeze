package promptcatalog

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// MaxIdentityNameRunes caps the MSP name shown on a prompt (spec §3.6).
const MaxIdentityNameRunes = 120

// MaxIdentityNameMarks caps consecutive combining marks after one letter.
const MaxIdentityNameMarks = 2

var confusableScripts = []*unicode.RangeTable{
	unicode.Latin, unicode.Cyrillic, unicode.Greek, unicode.Armenian, unicode.Cherokee, unicode.Coptic,
}

func isWhitespaceControl(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\u0085':
		return true
	}
	return false
}

// isBlankLetter: letters that render as nothing (Hangul fillers, Braille
// blank, Mongolian vowel separator). U+FFA0 is not listed: NFKC folds it to
// U+1160, which the second strip pass removes.
func isBlankLetter(r rune) bool {
	switch r {
	case 'ᅟ', 'ᅠ', 'ㅤ', '⠀', '᠎':
		return true
	}
	return false
}

func stripInvisible(s string) string {
	return strings.Map(func(r rune) rune {
		if r == unicode.ReplacementChar || isBlankLetter(r) || unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co, unicode.Cs) {
			return -1
		}
		return r
	}, s)
}

func capCombiningMarks(s string) string {
	var b strings.Builder
	run := 0
	for _, r := range s {
		if unicode.In(r, unicode.Mn, unicode.Me) {
			run++
			if run > MaxIdentityNameMarks {
				continue
			}
		} else {
			run = 0
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Reserved brand names (#10325), mirroring PROMPT_RESERVED_BRANDS and
// PROMPT_RESERVED_BRAND_QUALIFIERS in packages/shared/src/promptCatalog/sanitize.ts.
// A name whose letters and digits, read without case, diacritics, spaces or
// punctuation, are exactly a run of these words with at least one brand is
// shown as the generic name. TestReservedBrandListsMatchFixture keeps both
// lists equal to the shared fixture's `reservedBrands`.
var reservedBrands = []string{
	"microsoft", "windows", "apple", "macos", "icloud", "google", "azure",
}

var reservedBrandQualifiers = []string{
	"support", "security", "help", "desk", "service", "services", "team", "tech",
	"technical", "technician", "it", "customer", "care", "center", "centre", "update",
	"updates", "defender", "account", "accounts", "admin", "official", "store", "365",
	"inc", "corp", "corporation", "llc", "ltd", "the", "tm", "sm",
}

// brandKey: NFD, lower case, then only letters and digits (combining marks,
// spaces, punctuation and symbols dropped). A non-ASCII letter is kept, so it
// never matches the ASCII word lists.
func brandKey(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(s) {
		r = unicode.ToLower(r)
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isReservedKey reports whether key splits wholly into list words, at least
// one of them a brand.
func isReservedKey(key string) bool {
	if key == "" {
		return false
	}
	// reach[i]: 0 = key[:i] does not split; 1 = splits, no brand; 2 = splits with a brand.
	reach := make([]int, len(key)+1)
	reach[0] = 1
	for i := 0; i < len(key); i++ {
		here := reach[i]
		if here == 0 {
			continue
		}
		for _, w := range reservedBrands {
			if strings.HasPrefix(key[i:], w) {
				reach[i+len(w)] = 2
			}
		}
		for _, w := range reservedBrandQualifiers {
			if strings.HasPrefix(key[i:], w) && here > reach[i+len(w)] {
				reach[i+len(w)] = here
			}
		}
	}
	return reach[len(key)] == 2
}

func mixesConfusableScripts(word string) bool {
	seen := -1
	for _, r := range word {
		for i, tbl := range confusableScripts {
			if unicode.Is(tbl, r) {
				if seen >= 0 && seen != i {
					return true
				}
				seen = i
				break
			}
		}
	}
	return false
}

// SanitizeIdentityName cleans the MSP name shown on every device prompt. It is
// a spoofing control; it mirrors sanitizePromptPartnerName (packages/shared,
// which documents each step and the known limits) and both are pinned by
// fixtures/prompt-catalog/identity-name-sanitize.json. It returns "" where the
// TS function returns null: the caller then shows the localized generic name
// (common/identity.generic).
//
// Steps: whitespace controls → space; strip Cc, Cf, Co, Cs, U+FFFD, blank
// letters and invalid UTF-8; NFKC, then strip again; at most 2 consecutive
// combining marks; collapse whitespace and trim; a word mixing two confusable
// scripts rejects the whole name; cap at 120 runes and trim again; a reserved
// brand name ("Microsoft Support", #10325), before or after the cap, returns
// "". The result
// is plain text — never interpreted as markup or placeholders — and a renderer
// embedding it in running text must bidi-isolate it.
func SanitizeIdentityName(raw string) string {
	s := strings.Map(func(r rune) rune {
		if isWhitespaceControl(r) {
			return ' '
		}
		return r
	}, raw)
	s = stripInvisible(s) // ranging over invalid UTF-8 yields U+FFFD, stripped here
	s = stripInvisible(norm.NFKC.String(s))
	s = capCombiningMarks(s)

	var b strings.Builder
	space := false
	for _, r := range s {
		if unicode.In(r, unicode.Z) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	s = b.String()
	if s == "" {
		return ""
	}
	for _, word := range strings.Split(s, " ") {
		if mixesConfusableScripts(word) {
			return ""
		}
	}
	full := s
	if runes := []rune(s); len(runes) > MaxIdentityNameRunes {
		s = strings.TrimRight(string(runes[:MaxIdentityNameRunes]), " ")
	}
	// Both forms: the cap can cut a long brand-only name mid-word, or cut the
	// only non-list word off the end and leave just brand words on screen.
	if isReservedKey(brandKey(full)) || isReservedKey(brandKey(s)) {
		return ""
	}
	return s
}
