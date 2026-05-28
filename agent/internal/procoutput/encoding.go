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
	if utf8.Valid(b) {
		return string(b)
	}
	if decoded, ok := decodeWindowsConsoleBytes(b); ok {
		return decoded
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}
