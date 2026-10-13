package x11

import "testing"

func TestModifierMaskForKeycode(t *testing.T) {
	// 8 modifier rows (Shift, Lock, Control, Mod1..Mod5), 2 keycodes per row.
	codes := []byte{
		50, 62, // Shift
		66, 0, // Lock
		37, 105, // Control
		64, 108, // Mod1
		77, 0, // Mod2 (Num_Lock = 77 on a typical layout)
		0, 0, // Mod3
		133, 134, // Mod4
		92, 0, // Mod5
	}
	if got := modifierMaskForKeycode(2, codes, 77); got != 1<<4 {
		t.Fatalf("Num_Lock mask = %#x, want Mod2 (%#x)", got, 1<<4)
	}
	if got := modifierMaskForKeycode(2, codes, 66); got != 1<<1 {
		t.Fatalf("Caps_Lock mask = %#x, want Lock", got)
	}
	// Num_Lock bound to Mod3 on another layout: found by lookup, not assumed.
	codes[8], codes[10] = 0, 77
	if got := modifierMaskForKeycode(2, codes, 77); got != 1<<5 {
		t.Fatalf("Num_Lock on Mod3 = %#x, want %#x", got, 1<<5)
	}
	if got := modifierMaskForKeycode(2, codes, 200); got != 0 {
		t.Fatalf("unbound keycode mask = %#x, want 0", got)
	}
	if got := modifierMaskForKeycode(2, codes, 0); got != 0 {
		t.Fatal("keycode 0 is padding, never a match")
	}
	if got := modifierMaskForKeycode(0, codes, 77); got != 0 {
		t.Fatal("zero per-row width must not match")
	}
	if got := modifierMaskForKeycode(4, codes[:3], 77); got != 0 {
		t.Fatal("short reply must not index out of range")
	}
}
