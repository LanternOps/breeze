package x11

import "testing"

func TestKeysymForName(t *testing.T) {
	cases := map[string]uint32{
		"enter": 0xFF0D, "Return": 0xFF0D, "tab": 0xFF09, "space": 0x20,
		"backspace": 0xFF08, "escape": 0xFF1B, "left": 0xFF51, "up": 0xFF52,
		"right": 0xFF53, "down": 0xFF54, "pageup": 0xFF55, "home": 0xFF50,
		"f1": 0xFFBE, "f12": 0xFFC9, "-": 0x2D, "a": 0x61, "A": 0x41,
		"shift": 0xFFE1, "ctrl": 0xFFE3, "alt": 0xFFE9,
		"del": 0xFFFF, "delete": 0xFFFF, "add": 0xFFAB, "kp_add": 0xFFAB,
		"subtract": 0xFFAD, "decimal": 0xFFAE,
	}
	for name, want := range cases {
		got, ok := KeysymForName(name)
		if !ok || got != want {
			t.Errorf("KeysymForName(%q) = 0x%X,%v; want 0x%X", name, got, ok, want)
		}
	}
	if _, ok := KeysymForName("totally-unknown-key"); ok {
		t.Errorf("unknown key should return ok=false")
	}
}

func TestKeysymForRune(t *testing.T) {
	if KeysymForRune('A') != 0x41 {
		t.Errorf("latin1 identity failed")
	}
	// 'é' (U+00E9) is in the Latin-1 supplement (0xA0-0xFF), which X11 maps by
	// identity (XK_eacute == 0x00e9 in keysymdef.h) — NOT the 0x01000000|codepoint
	// convention. This must match the real server keysym so the keymap_linux.go
	// reverse lookup (keyed off GetKeyboardMapping's actual keysyms) can find it.
	if KeysymForRune('é') != 0xE9 {
		t.Errorf("latin1 supplement identity failed: got 0x%X", KeysymForRune('é'))
	}
	// '€' (U+20AC) is outside Latin-1, so it must use the Unicode convention.
	if KeysymForRune('€') != (0x01000000 | 0x20AC) {
		t.Errorf("unicode keysym convention failed: got 0x%X", KeysymForRune('€'))
	}
}
