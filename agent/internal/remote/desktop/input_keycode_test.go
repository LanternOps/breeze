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

// TestWinKeyInputPrintableKeysFromCode (#3920): the main typing block is
// injected by scancode when the viewer sends a code, i.e. in Physical keys
// mode. The key-name path maps punctuation names to US-layout VK_OEM_* codes,
// which sit on different keys under French/Belgian AZERTY, Spanish or German
// layouts (the ' key typed ² on French, - typed ç on Spanish). A scancode is
// what the remote layout resolves itself, so a same-layout session types
// exactly what the operator pressed.
func TestWinKeyInputPrintableKeysFromCode(t *testing.T) {
	cases := map[string]uint16{
		"Backquote": 0x29,
		"Digit1":    0x02, "Digit2": 0x03, "Digit3": 0x04, "Digit4": 0x05, "Digit5": 0x06,
		"Digit6": 0x07, "Digit7": 0x08, "Digit8": 0x09, "Digit9": 0x0A, "Digit0": 0x0B,
		"Minus": 0x0C, "Equal": 0x0D,
		"KeyQ": 0x10, "KeyW": 0x11, "KeyE": 0x12, "KeyR": 0x13, "KeyT": 0x14,
		"KeyY": 0x15, "KeyU": 0x16, "KeyI": 0x17, "KeyO": 0x18, "KeyP": 0x19,
		"BracketLeft": 0x1A, "BracketRight": 0x1B,
		"KeyA": 0x1E, "KeyS": 0x1F, "KeyD": 0x20, "KeyF": 0x21, "KeyG": 0x22,
		"KeyH": 0x23, "KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26,
		"Semicolon": 0x27, "Quote": 0x28, "Backslash": 0x2B,
		"KeyZ": 0x2C, "KeyX": 0x2D, "KeyC": 0x2E, "KeyV": 0x2F, "KeyB": 0x30,
		"KeyN": 0x31, "KeyM": 0x32, "Comma": 0x33, "Period": 0x34, "Slash": 0x35,
	}
	for code, scan := range cases {
		for _, up := range []bool{false, true} {
			// key is the layout-produced name; it must be ignored once code wins.
			got, ok := winKeyInputFor(code, "q", up, fakeScan)
			if !ok {
				t.Fatalf("%s: not mapped", code)
			}
			flags := uint32(winKeyeventfScancode)
			if up {
				flags |= winKeyeventfKeyUp
			}
			want := winKeyInput{VK: 0, Scan: scan, Flags: flags}
			if got != want {
				t.Fatalf("%s up=%v: got %+v, want %+v", code, up, got, want)
			}
		}
	}
}

// TestWinKeyInputCodeOutsideTableUsesKey: keys whose VK is layout-independent
// (Enter, F-row, Space, editing keys) stay on the key-name path, as do lock
// keys and Pause (Pause is an E1 sequence, and lock keys are driven by state
// sync). An unknown code falls back to the name, never an error.
func TestWinKeyInputCodeOutsideTableUsesKey(t *testing.T) {
	cases := []struct{ code, key string }{
		{"Enter", "enter"},
		{"Space", "space"},
		{"Backspace", "backspace"},
		{"Tab", "tab"},
		{"Escape", "escape"},
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
