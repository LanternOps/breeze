package userhelper

import (
	"strings"
	"unicode/utf8"
)

// MaxBannerLabelBytes is the longest label the session banner shows; a longer
// one is cut at this many bytes.
const MaxBannerLabelBytes = maxNotifyTitleBytes

// DisplayNameWithin returns name ready to show to the end user: control and
// bidirectional formatting characters removed, surrounding space trimmed,
// and shortened to at most maxBytes without splitting a character. Callers
// that put a name into a sentence shorten the name with it, so the sentence
// itself always survives the banner's label limit.
func DisplayNameWithin(name string, maxBytes int) string {
	return truncateUTF8(strings.TrimSpace(stripControl(name)), maxBytes)
}

// truncateUTF8 cuts s to at most max bytes on a character boundary.
func truncateUTF8(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
