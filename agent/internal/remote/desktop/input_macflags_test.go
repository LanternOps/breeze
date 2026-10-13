package desktop

import "testing"

func TestMacModifierKey(t *testing.T) {
	cases := []struct {
		name, code string
		flag, kc   int
	}{
		{"shift", "", cgEventFlagMaskShift, 0x38},
		{"shift", "ShiftLeft", cgEventFlagMaskShift, 0x38},
		{"shift", "ShiftRight", cgEventFlagMaskShift, 0x3C},
		{"ctrl", "ControlRight", cgEventFlagMaskControl, 0x3E},
		{"control", "", cgEventFlagMaskControl, 0x3B},
		{"alt", "AltRight", cgEventFlagMaskAlternate, 0x3D},
		{"alt", "", cgEventFlagMaskAlternate, 0x3A},
		{"meta", "", cgEventFlagMaskCommand, 0x37},
		{"meta", "MetaRight", cgEventFlagMaskCommand, 0x36},
		{"cmd", "", cgEventFlagMaskCommand, 0x37},
	}
	for _, tc := range cases {
		flag, kc, ok := macModifierKey(tc.name, tc.code)
		if !ok || flag != tc.flag || kc != tc.kc {
			t.Fatalf("%s/%s: got flag %#x kc %#x ok %v, want %#x %#x", tc.name, tc.code, flag, kc, ok, tc.flag, tc.kc)
		}
	}
	for _, k := range []string{"a", "capslock", "space", ""} {
		if _, _, ok := macModifierKey(k, ""); ok {
			t.Fatalf("%q is not a modifier", k)
		}
	}
}

func TestMacModifierMaskPressRelease(t *testing.T) {
	var m macModifierMask
	if m.flags() != 0 {
		t.Fatal("empty mask must be 0")
	}
	m.press("shift", "ShiftLeft")
	m.press("meta", "MetaLeft")
	if got := m.flags(); got != cgEventFlagMaskShift|cgEventFlagMaskCommand {
		t.Fatalf("flags = %#x", got)
	}
	if _, ok := m.release("shift", "ShiftLeft"); !ok {
		t.Fatal("release of a held key must report ok")
	}
	if got := m.flags(); got != cgEventFlagMaskCommand {
		t.Fatalf("after shift up flags = %#x", got)
	}
}

// Both Shifts down, one released: Shift is still down.
func TestMacModifierMaskBothSides(t *testing.T) {
	var m macModifierMask
	m.press("shift", "ShiftLeft")
	m.press("shift", "ShiftRight")
	m.release("shift", "ShiftLeft")
	if m.flags() != cgEventFlagMaskShift {
		t.Fatalf("flags = %#x, want shift still set", m.flags())
	}
	m.release("shift", "ShiftRight")
	if m.flags() != 0 {
		t.Fatalf("flags = %#x, want 0", m.flags())
	}
}

// A release without the code that pressed it (or with a different one) still
// clears that modifier: an extra release is harmless, a latched Cmd is not.
func TestMacModifierMaskReleaseByNameFallback(t *testing.T) {
	var m macModifierMask
	m.press("ctrl", "ControlRight")
	if _, ok := m.release("ctrl", ""); !ok {
		t.Fatal("release by name should clear a code-held ctrl")
	}
	if m.flags() != 0 {
		t.Fatalf("flags = %#x, want 0", m.flags())
	}
}

func TestMacModifierMaskReleaseUnheld(t *testing.T) {
	var m macModifierMask
	if _, ok := m.release("shift", ""); ok {
		t.Fatal("release of an unheld modifier must report !ok (legacy path)")
	}
}

func TestMacModifierMaskClear(t *testing.T) {
	var m macModifierMask
	m.press("alt", "")
	m.clear()
	if m.flags() != 0 {
		t.Fatal("clear must zero the mask")
	}
}

// Legacy: with nothing held and no Caps Lock assertion, key events keep the
// ambient flags (setFlags false), exactly as before W2c.
func TestMacKeyFlagsLegacyUnchanged(t *testing.T) {
	flags, set := macKeyFlags(0, nil)
	if flags != 0 || set {
		t.Fatalf("legacy key flags = %#x set=%v, want 0 false", flags, set)
	}
	on := true
	flags, set = macKeyFlags(0, &on)
	if flags != cgEventFlagMaskAlphaShift || !set {
		t.Fatalf("caps only = %#x set=%v", flags, set)
	}
}

func TestMacKeyFlagsWithHeldModifiers(t *testing.T) {
	off := false
	flags, set := macKeyFlags(cgEventFlagMaskShift, nil)
	if flags != cgEventFlagMaskShift || !set {
		t.Fatalf("held shift = %#x set=%v", flags, set)
	}
	flags, set = macKeyFlags(cgEventFlagMaskShift|cgEventFlagMaskAlphaShift, &off)
	if flags != cgEventFlagMaskShift || !set {
		t.Fatalf("held shift, caps off = %#x set=%v", flags, set)
	}
}

func TestMacPointerFlags(t *testing.T) {
	if f, set := macPointerFlags(0); f != 0 || set {
		t.Fatal("legacy pointer events must leave flags alone")
	}
	if f, set := macPointerFlags(cgEventFlagMaskCommand); f != cgEventFlagMaskCommand || !set {
		t.Fatal("Cmd held: pointer events carry Cmd (Cmd+click)")
	}
}
