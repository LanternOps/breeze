package userhelper

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestStripControlAlsoRemovesBidiOverrideAndIsolateCharacters(t *testing.T) {
	in := "a\u202ab\u202bc\u202cd\u202de\u202ef\u2066g\u2067h\u2068i\u2069j\x00k\x7fl\nm"
	if got := stripControl(in); got != "abcdefghijklm" {
		t.Fatalf("stripControl = %q", got)
	}
}

func TestTrimNotifyFieldNeverSplitsACharacter(t *testing.T) {
	got := trimNotifyField(strings.Repeat("é", 200), 255) // 400 bytes, odd cut
	if !utf8.ValidString(got) || len(got) > 255 {
		t.Fatalf("trimmed to %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestDisplayNameWithinShortensRuneSafeAndSanitises(t *testing.T) {
	got := DisplayNameWithin("\u202eÄ"+strings.Repeat("Ä", 100), 11)
	if !utf8.ValidString(got) || len(got) > 11 || strings.ContainsRune(got, '\u202e') {
		t.Fatalf("DisplayNameWithin = %q (%d bytes)", got, len(got))
	}
	if got := DisplayNameWithin("  Billy  ", 50); got != "Billy" {
		t.Fatalf("DisplayNameWithin trims surrounding space, got %q", got)
	}
}
