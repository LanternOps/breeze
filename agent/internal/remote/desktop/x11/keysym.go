package x11

import "strings"

// namedKeysyms maps lower-cased viewer key names to X keysym values.
var namedKeysyms = map[string]uint32{
	"enter": 0xFF0D, "return": 0xFF0D, "tab": 0xFF09, "space": 0x20,
	"backspace": 0xFF08, "escape": 0xFF1B, "esc": 0xFF1B, "delete": 0xFFFF, "del": 0xFFFF,
	"insert": 0xFF63, "home": 0xFF50, "end": 0xFF57,
	"left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54,
	"pageup": 0xFF55, "pagedown": 0xFF56,
	"f1": 0xFFBE, "f2": 0xFFBF, "f3": 0xFFC0, "f4": 0xFFC1, "f5": 0xFFC2,
	"f6": 0xFFC3, "f7": 0xFFC4, "f8": 0xFFC5, "f9": 0xFFC6, "f10": 0xFFC7,
	"f11": 0xFFC8, "f12": 0xFFC9,
	"num0": 0xFFB0, "num1": 0xFFB1, "num2": 0xFFB2, "num3": 0xFFB3, "num4": 0xFFB4,
	"num5": 0xFFB5, "num6": 0xFFB6, "num7": 0xFFB7, "num8": 0xFFB8, "num9": 0xFFB9,
	// Numpad operators (XK_KP_*). Both the bare and kp_-prefixed spellings map
	// to the same keysyms.
	"add": 0xFFAB, "subtract": 0xFFAD, "multiply": 0xFFAA, "divide": 0xFFAF, "decimal": 0xFFAE,
	"kp_add": 0xFFAB, "kp_subtract": 0xFFAD, "kp_multiply": 0xFFAA, "kp_divide": 0xFFAF, "kp_decimal": 0xFFAE,
	"capslock": 0xFFE5, "numlock": 0xFF7F, "scrolllock": 0xFF14,
	"printscreen": 0xFF61, "print": 0xFF61, "pause": 0xFF13,
	"shift": 0xFFE1, "ctrl": 0xFFE3, "control": 0xFFE3, "alt": 0xFFE9,
	"meta": 0xFFEB, "super": 0xFFEB, "cmd": 0xFFEB,
	"-": 0x2D, "=": 0x3D, "[": 0x5B, "]": 0x5D, "\\": 0x5C, ";": 0x3B,
	"'": 0x27, "`": 0x60, ",": 0x2C, ".": 0x2E, "/": 0x2F,
}

// KeysymForName maps a viewer key name (e.g. "enter","Left","a","F5","-") to an
// X keysym value. Returns (0,false) if unknown.
func KeysymForName(name string) (uint32, bool) {
	if name == "" {
		return 0, false
	}
	if ks, ok := namedKeysyms[strings.ToLower(name)]; ok {
		return ks, true
	}
	// Single printable character (case-sensitive): identity for Latin-1.
	r := []rune(name)
	if len(r) == 1 {
		return KeysymForRune(r[0]), true
	}
	return 0, false
}

// KeysymForRune maps a printable rune to a keysym (Latin-1 identity, else the
// 0x01000000|codepoint Unicode convention).
func KeysymForRune(r rune) uint32 {
	if (r >= 0x20 && r <= 0x7E) || (r >= 0xA0 && r <= 0xFF) {
		return uint32(r)
	}
	return 0x01000000 | uint32(r)
}
