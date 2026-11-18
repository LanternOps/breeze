package promptcatalog

import "strings"

// Locale is one of the eight prompt locales.
type Locale string

// LocaleEN is the default and fallback locale.
const LocaleEN Locale = "en"

// Locales lists the eight prompt locales in the catalog's canonical order
// (PROMPT_LOCALES in packages/shared).
var Locales = []Locale{"en", "de-DE", "es-419", "fr-FR", "fr-CA", "it-IT", "pt-BR", "tr-TR"}

var byLanguage = map[string]Locale{
	"en": "en",
	"de": "de-DE",
	"es": "es-419",
	"fr": "fr-FR",
	"it": "it-IT",
	"pt": "pt-BR",
	"tr": "tr-TR",
}

// isTagByte: ASCII letters, digits and the separators a locale tag may hold.
func isTagByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return c == '_' || c == '-' || c == '.' || c == '@'
}

// Negotiate maps any OS / BCP 47 / POSIX locale tag onto one of the eight
// prompt locales. Deterministic and total; mirrors negotiatePromptLocale and is
// pinned by packages/shared/src/fixtures/prompt-catalog/locale-negotiation.json.
//
//  1. Trim ASCII whitespace; a tag holding anything but ASCII letters, digits
//     and "_ - . @" → en. Lower-case, "_" → "-", drop a POSIX ".codeset" and
//     "@modifier".
//  2. An exact match among the eight wins.
//  3. "fr-ca" followed by another subtag → fr-CA.
//  4. Otherwise the primary subtag (exactly; "fry" is not "fr") picks the locale.
//  5. Anything else → en.
func Negotiate(tag string) Locale {
	t := strings.Trim(tag, " \t\n\v\f\r")
	for i := 0; i < len(t); i++ {
		if !isTagByte(t[i]) {
			return LocaleEN
		}
	}
	t = strings.ReplaceAll(strings.ToLower(t), "_", "-")
	if i := strings.IndexByte(t, '@'); i >= 0 {
		t = t[:i]
	}
	if i := strings.IndexByte(t, '.'); i >= 0 {
		t = t[:i]
	}
	for _, l := range Locales {
		if strings.ToLower(string(l)) == t {
			return l
		}
	}
	if strings.HasPrefix(t, "fr-ca-") {
		return "fr-CA"
	}
	primary := t
	if i := strings.IndexByte(t, '-'); i >= 0 {
		primary = t[:i]
	}
	if l, ok := byLanguage[primary]; ok {
		return l
	}
	return LocaleEN
}
