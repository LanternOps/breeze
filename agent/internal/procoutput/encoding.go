package procoutput

import (
	"strings"
	"unicode/utf8"
)

// BytesToUTF8 converts captured process stdout/stderr bytes into a valid UTF-8
// string suitable for JSON marshaling and web UI display. Valid UTF-8 input is
// returned unchanged; on Windows, non-UTF-8 bytes are transcoded from the
// active console code page when possible.
func BytesToUTF8(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	// When bytes are already valid UTF-8, passthrough even though some Windows
	// code pages (e.g. CP1252) can produce byte sequences that happen to decode
	// as valid UTF-8. Transcoding speculatively without a reliable locale hint
	// would corrupt genuinely UTF-8 output, so passthrough is the safer trade-off.
	if utf8.Valid(b) {
		return string(b)
	}
	if decoded, ok := decodeWindowsConsoleBytes(b); ok {
		return decoded
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}
