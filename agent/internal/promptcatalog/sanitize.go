package promptcatalog

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// MaxIdentityNameRunes caps the MSP name shown on a prompt (spec §3.6).
const MaxIdentityNameRunes = 120

var confusableScripts = []*unicode.RangeTable{unicode.Latin, unicode.Cyrillic, unicode.Greek}

func isWhitespaceControl(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\u0085':
		return true
	}
	return false
}

func stripInvisible(s string) string {
	return strings.Map(func(r rune) rune {
		if r == unicode.ReplacementChar || unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co, unicode.Cs) {
			return -1
		}
		return r
	}, s)
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
// a spoofing control; it mirrors sanitizePromptPartnerName (packages/shared) and
// both are pinned by fixtures/prompt-catalog/identity-name-sanitize.json.
// It returns "" where the TS function returns null: the caller then shows the
// localized generic name (common/identity.generic).
//
// Steps: whitespace controls → space; strip Cc, Cf (bidi controls, zero-width
// characters, BOM, soft hyphen, tag characters), Co, Cs, U+FFFD and invalid
// UTF-8; NFKC (folds fullwidth / mathematical look-alikes); collapse
// whitespace and trim; a word mixing Latin, Cyrillic and Greek letters rejects
// the whole name; cap at 120 runes and trim again. The result is plain text —
// markup and {placeholders} are kept verbatim and never interpreted.
func SanitizeIdentityName(raw string) string {
	s := strings.Map(func(r rune) rune {
		if isWhitespaceControl(r) {
			return ' '
		}
		return r
	}, raw)
	s = stripInvisible(s) // ranging over invalid UTF-8 yields U+FFFD, stripped here
	s = stripInvisible(norm.NFKC.String(s))

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
	if runes := []rune(s); len(runes) > MaxIdentityNameRunes {
		s = strings.TrimRight(string(runes[:MaxIdentityNameRunes]), " ")
	}
	return s
}
