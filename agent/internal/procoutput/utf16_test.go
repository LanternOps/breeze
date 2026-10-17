package procoutput

import (
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

func utf16LE(s string, bom bool) []byte {
	var b []byte
	if bom {
		b = append(b, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		b = append(b, byte(u), byte(u>>8))
	}
	return b
}

// Windows PowerShell can write UTF-16LE to a redirected stderr. string() of
// those bytes keeps a NUL after every ASCII character, and the NULs travel
// into heartbeat log lines that Postgres rejects (U+0000).
func TestDecodeConsoleText(t *testing.T) {
	const msg = "Service is not running.\r\n"
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"nil", nil, ""},
		{"empty", []byte{}, ""},
		{"utf16le with BOM", utf16LE(msg, true), msg},
		{"utf16le without BOM", utf16LE(msg, false), msg},
		{"utf16le non-ASCII with BOM", utf16LE("Zugriff verweigert: café 日本 \U0001F600", true), "Zugriff verweigert: café 日本 \U0001F600"},
		{"utf16le BOM only", []byte{0xFF, 0xFE}, ""},
		{"utf16le BOM with odd trailing byte", append(utf16LE("ok", true), 'x'), "ok"},
		{"plain ASCII unchanged", []byte(msg), msg},
		{"UTF-8 unchanged", []byte("café résumé 日本語 привет"), "café résumé 日本語 привет"},
		{"even-length UTF-8 is not mistaken for UTF-16", []byte("abcd"), "abcd"},
		{"stray NUL in UTF-8 removed", []byte("ab\x00d"), "abd"},
		{"odd-length NUL-laced garbage", []byte{'A', 0x00, 'B'}, "AB"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DecodeConsoleText(tc.in); got != tc.want {
				t.Fatalf("DecodeConsoleText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Whatever arrives, the result must be valid UTF-8 without U+0000.
func TestDecodeConsoleTextNeverReturnsNUL(t *testing.T) {
	inputs := [][]byte{
		{0xFF, 0x00, 0xFE},             // odd length, invalid UTF-8
		{0xFF, 0xFE, 0x00, 0x00},       // BOM then an encoded U+0000
		{0x00, 0x00, 0x00, 0x00},       // all NUL
		{0x00, 0xD8, 0x41, 0x00},       // unpaired high surrogate
		{0xFE, 0xFF, 0x00, 0x41, 0x00}, // big-endian BOM, odd length
		append(utf16LE("abc", false), 0x00),
	}
	for _, in := range inputs {
		got := DecodeConsoleText(in)
		if strings.ContainsRune(got, 0) || !utf8.ValidString(got) {
			t.Fatalf("DecodeConsoleText(%q) = %q: contains NUL or invalid UTF-8", in, got)
		}
	}
}
