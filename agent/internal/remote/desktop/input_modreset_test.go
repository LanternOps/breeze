package desktop

import (
	"reflect"
	"testing"
)

func TestWinStuckModifiersReleasesOnlyKeysTheOSReportsDown(t *testing.T) {
	down := map[uint16]bool{0xA2: true, 0x5B: true} // left Ctrl, left Win
	got := winStuckModifiers(func(vk uint16) bool { return down[vk] })

	want := []winKeyInput{
		{Scan: 0x1D, Flags: winKeyeventfScancode | winKeyeventfKeyUp},                           // ControlLeft
		{Scan: 0x5B, Flags: winKeyeventfScancode | winKeyeventfKeyUp | winKeyeventfExtendedKey}, // MetaLeft
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %+v, want %+v", got, want)
	}
}

func TestWinStuckModifiersCoversEverySidedModifier(t *testing.T) {
	if got := winStuckModifiers(func(uint16) bool { return true }); len(got) != 8 {
		t.Fatalf("releases = %d, want 8 (Shift, Ctrl, Alt, Win; both sides)", len(got))
	}
	if got := winStuckModifiers(func(uint16) bool { return false }); len(got) != 0 {
		t.Fatalf("nothing down, releases = %+v", got)
	}
}

func TestMacModifierResetCoversBothSidesOfEveryModifier(t *testing.T) {
	want := []int{0x38, 0x3C, 0x3B, 0x3E, 0x3A, 0x3D, 0x37, 0x36}
	if !reflect.DeepEqual(macModifierKeycodes, want) {
		t.Fatalf("keycodes = %#x, want %#x", macModifierKeycodes, want)
	}
}

// A reset releases modifiers, never Caps Lock: Caps Lock is a toggle the
// viewer asserts on every keystroke.
func TestMacModifierResetFlagsKeepsOnlyCapsLock(t *testing.T) {
	all := cgEventFlagMaskShift | cgEventFlagMaskControl | cgEventFlagMaskAlternate | cgEventFlagMaskCommand
	if got := macModifierResetFlags(all | cgEventFlagMaskAlphaShift); got != cgEventFlagMaskAlphaShift {
		t.Fatalf("flags = %#x, want Caps Lock only", got)
	}
	if got := macModifierResetFlags(all); got != 0 {
		t.Fatalf("flags = %#x, want 0", got)
	}
}
