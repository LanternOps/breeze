package desktop

import (
	"reflect"
	"strings"
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

// A modifier release that SendInput refuses is the stuck key the operator
// asked to clear: it must surface as an error, not a debug line.
func TestReleaseStuckModifiersReportsEveryRefusedRelease(t *testing.T) {
	releases := winStuckModifiers(func(uint16) bool { return true })
	var sent []winKeyInput
	err := releaseStuckModifiers(releases, func(k winKeyInput) bool {
		sent = append(sent, k)
		left := k.Flags&winKeyeventfExtendedKey == 0
		return !left || (k.Scan != 0x1D && k.Scan != 0x38) // left Ctrl and left Alt refused
	})
	if err == nil {
		t.Fatal("err = nil, want a failure naming the refused releases")
	}
	if len(sent) != len(releases) {
		t.Fatalf("sent %d of %d: a refusal must not stop the remaining releases", len(sent), len(releases))
	}
	if got := err.Error(); !strings.Contains(got, "2 of 8") || !strings.Contains(got, "0x1D") || !strings.Contains(got, "0x38") {
		t.Fatalf("err = %q, want the count and the refused scan codes", got)
	}
	if err := releaseStuckModifiers(releases, func(winKeyInput) bool { return true }); err != nil {
		t.Fatalf("all accepted, err = %v", err)
	}
	if err := releaseStuckModifiers(nil, func(winKeyInput) bool { return false }); err != nil {
		t.Fatalf("nothing to release, err = %v", err)
	}
}
