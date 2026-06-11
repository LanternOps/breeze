package procoutput

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// charmapForCodePage maps a Windows code page identifier to a charmap decoder.
// Unmapped code pages return nil; callers must fall back to ToValidUTF8 rather
// than guessing a Western European encoding.
func charmapForCodePage(cp uint32) *charmap.Charmap {
	switch cp {
	case 437:
		return charmap.CodePage437
	case 850:
		return charmap.CodePage850
	case 852:
		return charmap.CodePage852
	case 855:
		return charmap.CodePage855
	case 858:
		return charmap.CodePage858
	case 860:
		return charmap.CodePage860
	case 862:
		return charmap.CodePage862
	case 863:
		return charmap.CodePage863
	case 865:
		return charmap.CodePage865
	case 866:
		return charmap.CodePage866
	case 874:
		return charmap.Windows874
	case 1250:
		return charmap.Windows1250
	case 1251:
		return charmap.Windows1251
	case 1252:
		return charmap.Windows1252
	case 1253:
		return charmap.Windows1253
	case 1254:
		return charmap.Windows1254
	case 1255:
		return charmap.Windows1255
	case 1256:
		return charmap.Windows1256
	case 1257:
		return charmap.Windows1257
	case 1258:
		return charmap.Windows1258
	default:
		return nil
	}
}

// decodeFromWindowsCodePage transcodes bytes using an explicit Windows code page.
// Used by the Windows runtime path and by unit tests on all platforms.
func decodeFromWindowsCodePage(b []byte, cp uint32) (string, bool) {
	if cp == 65001 {
		return "", false
	}
	enc := charmapForCodePage(cp)
	if enc == nil {
		return "", false
	}
	return transcode(b, enc)
}

func transcode(b []byte, enc *charmap.Charmap) (string, bool) {
	if enc == nil {
		return "", false
	}
	decoded, err := enc.NewDecoder().Bytes(b)
	if err != nil || !utf8.Valid(decoded) {
		return "", false
	}
	return strings.TrimRight(string(decoded), "\x00"), true
}
