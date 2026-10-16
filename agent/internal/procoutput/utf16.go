package procoutput

import (
	"strings"
	"unicode/utf16"
)

// DecodeConsoleText converts captured process output that may be UTF-16LE into
// a valid UTF-8 string with no NUL characters. Windows PowerShell can write
// UTF-16LE to a redirected stream; string() of those bytes keeps a NUL after
// every ASCII character, and U+0000 is rejected downstream (Postgres text and
// jsonb). UTF-16LE is recognised by its BOM (FF FE) or, without one, by an even
// length with most odd-index bytes zero. Anything else goes through
// BytesToUTF8. Any remaining NUL is removed as a final guard.
func DecodeConsoleText(b []byte) string {
	var s string
	if u, ok := utf16LEUnits(b); ok {
		s = string(utf16.Decode(u))
	} else {
		s = BytesToUTF8(b)
	}
	return strings.ReplaceAll(s, "\x00", "")
}

func utf16LEUnits(b []byte) ([]uint16, bool) {
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		b = b[2 : 2+(len(b)-2)&^1] // drop the BOM and any trailing odd byte
	} else if !looksUTF16LE(b) {
		return nil, false
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
	}
	return u, true
}

// looksUTF16LE reports whether BOM-less b is plausibly UTF-16LE: even length,
// and more than half of the high (odd-index) bytes are zero, which holds for
// any text that is mostly ASCII. UTF-8 text essentially never contains NULs.
func looksUTF16LE(b []byte) bool {
	if len(b) < 2 || len(b)%2 != 0 {
		return false
	}
	zeros := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	return zeros*2 > len(b)/2
}
