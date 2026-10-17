package desktop

import "testing"

// fakeScan stands in for MapVirtualKeyW so the tuple is checkable off Windows.
func fakeScan(vk uint16) uint16 { return 0x100 + vk }

// TestWinKeyInputLegacyUnchanged pins the pre-W2c tuple for events without a
// code: the same VK, the MapVirtualKey scancode, and the extended flag for the
// nav cluster, exactly as SendKeyDown/SendKeyUp built it before.
func TestWinKeyInputLegacyUnchanged(t *testing.T) {
	cases := []struct {
		key      string
		vk       uint16
		extended bool
	}{
		{"a", 'A', false},
		{"Z", 'Z', false},
		{"7", '7', false},
		{"enter", 0x0D, false},
		{" ", 0x20, false},
		{"up", 0x26, true},
		{"delete", 0x2E, true},
		{"home", 0x24, true},
		{"divide", 0x6F, true},
		{"shift", 0x10, false},
		{"ctrl", 0x11, false},
		{"alt", 0x12, false},
		{"meta", 0x5B, true},
		{"f5", 0x74, false},
		{"capslock", 0x14, false},
		{"numlock", 0x90, true},
	}
	for _, tc := range cases {
		for _, up := range []bool{false, true} {
			got, ok := winKeyInputFor("", tc.key, up, fakeScan)
			if !ok {
				t.Fatalf("%q up=%v: not mapped", tc.key, up)
			}
			var flags uint32
			if tc.extended {
				flags |= winKeyeventfExtendedKey
			}
			if up {
				flags |= winKeyeventfKeyUp
			}
			want := winKeyInput{VK: tc.vk, Scan: fakeScan(tc.vk), Flags: flags}
			if got != want {
				t.Fatalf("%q up=%v: got %+v, want %+v", tc.key, up, got, want)
			}
		}
	}
}

func TestWinKeyInputUnknownKeyNotMapped(t *testing.T) {
	if _, ok := winKeyInputFor("", "nosuchkey", false, fakeScan); ok {
		t.Fatal("unknown key without code must not map")
	}
	if _, ok := winKeyInputFor("Lang9", "nosuchkey", false, fakeScan); ok {
		t.Fatal("unknown code plus unknown key must not map")
	}
}

// TestWinKeyInputFromCode covers the keys spec K11 lists: each is injected by
// scancode, with the extended flag where the key lives in the E0 table.
func TestWinKeyInputFromCode(t *testing.T) {
	cases := []struct {
		code     string
		scan     uint16
		extended bool
	}{
		{"ShiftLeft", 0x2A, false},
		{"ShiftRight", 0x36, false},
		{"ControlLeft", 0x1D, false},
		{"ControlRight", 0x1D, true},
		{"AltLeft", 0x38, false},
		{"AltRight", 0x38, true},
		{"MetaLeft", 0x5B, true},
		{"MetaRight", 0x5C, true},
		{"OSLeft", 0x5B, true},
		{"OSRight", 0x5C, true},
		{"ContextMenu", 0x5D, true},
		{"NumpadEnter", 0x1C, true},
		{"NumpadDivide", 0x35, true},
		{"ArrowUp", 0x48, true},
		{"ArrowDown", 0x50, true},
		{"ArrowLeft", 0x4B, true},
		{"ArrowRight", 0x4D, true},
		{"Insert", 0x52, true},
		{"Delete", 0x53, true},
		{"Home", 0x47, true},
		{"End", 0x4F, true},
		{"PageUp", 0x49, true},
		{"PageDown", 0x51, true},
		{"F13", 0x64, false},
		{"F23", 0x6E, false},
		{"F24", 0x76, false},
		{"IntlBackslash", 0x56, false},
		{"IntlRo", 0x73, false},
		{"IntlYen", 0x7D, false},
		{"AudioVolumeMute", 0x20, true},
		{"AudioVolumeDown", 0x2E, true},
		{"AudioVolumeUp", 0x30, true},
		{"MediaTrackNext", 0x19, true},
		{"MediaTrackPrevious", 0x10, true},
		{"MediaStop", 0x24, true},
		{"MediaPlayPause", 0x22, true},
	}
	for _, tc := range cases {
		for _, up := range []bool{false, true} {
			// key is deliberately something else: code wins when it is known.
			got, ok := winKeyInputFor(tc.code, "a", up, fakeScan)
			if !ok {
				t.Fatalf("%s: not mapped", tc.code)
			}
			flags := uint32(winKeyeventfScancode)
			if tc.extended {
				flags |= winKeyeventfExtendedKey
			}
			if up {
				flags |= winKeyeventfKeyUp
			}
			want := winKeyInput{VK: 0, Scan: tc.scan, Flags: flags}
			if got != want {
				t.Fatalf("%s up=%v: got %+v, want %+v", tc.code, up, got, want)
			}
		}
	}
}

// TestWinKeyInputCodeOutsideTableUsesKey: letters, digits and symbols are
// deliberately not in the scancode table. A scancode is a physical position,
// so KeyA on an AZERTY remote would type "q"; the VK path keeps today's
// layout behaviour. Lock keys and Pause stay on the VK path as well (Pause is
// an E1 sequence, and lock keys are driven by state sync).
func TestWinKeyInputCodeOutsideTableUsesKey(t *testing.T) {
	cases := []struct{ code, key string }{
		{"KeyA", "a"},
		{"Digit1", "1"},
		{"Minus", "-"},
		{"Enter", "enter"},
		{"F5", "f5"},
		{"CapsLock", "capslock"},
		{"NumLock", "numlock"},
		{"Pause", "pause"},
		{"Lang9", "a"},
	}
	for _, tc := range cases {
		got, ok := winKeyInputFor(tc.code, tc.key, false, fakeScan)
		want, _ := winKeyInputFor("", tc.key, false, fakeScan)
		if !ok || got != want {
			t.Fatalf("%s/%s: got %+v ok=%v, want key path %+v", tc.code, tc.key, got, ok, want)
		}
	}
}
