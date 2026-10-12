package desktop

import (
	"reflect"
	"testing"
)

// W2c: a key pressed by code is released by the same code. Released by key
// name only, a right Ctrl pressed by scancode would be released as VK_CONTROL
// (left Ctrl) on Windows, leaving right Ctrl stuck.
func TestHeldInputReleasesCodeKeysByCode(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "control", Code: "ControlRight"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "a"}, nil)
	want := []InputEvent{
		{Type: "key_up", Key: "a"},
		{Type: "key_up", Key: "ctrl", Code: "ControlRight"},
	}
	if got := h.releases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("releases:\n got %+v\nwant %+v", got, want)
	}
}

// Both Shifts held, one released: the other stays held and is released later.
// Keyed by name only, releasing ShiftLeft would forget ShiftRight.
func TestHeldInputTracksLeftAndRightSeparately(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift", Code: "ShiftLeft"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "shift", Code: "ShiftRight"}, nil)
	h.observe(InputEvent{Type: "key_up", Key: "shift", Code: "ShiftLeft"}, nil)
	if n := h.count(); n != 1 {
		t.Fatalf("count = %d, want 1 (ShiftRight)", n)
	}
	want := []InputEvent{{Type: "key_up", Key: "shift", Code: "ShiftRight"}}
	if got := h.releases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %+v, want %+v", got, want)
	}
}

// A repeated key_down (forwarded autorepeat, spec K7) is still one held key.
func TestHeldInputRepeatIsOneKey(t *testing.T) {
	h := newHeldInput()
	for i := 0; i < 5; i++ {
		h.observe(InputEvent{Type: "key_down", Key: "backspace", Code: "Backspace"}, nil)
	}
	if n := h.count(); n != 1 {
		t.Fatalf("count = %d, want 1", n)
	}
}

// K5 still applies to code-held modifiers: Shift held as ShiftLeft means a
// key_press must not re-press and release "shift".
func TestHeldInputPrepareSeesCodeHeldModifiers(t *testing.T) {
	h := newHeldInput()
	h.goos = "windows"
	h.observe(InputEvent{Type: "key_down", Key: "Shift", Code: "ShiftLeft"}, nil)
	ev := h.prepare(InputEvent{Type: "key_press", Key: "a", Code: "KeyA", Modifiers: []string{"shift", "ctrl"}})
	if want := []string{"ctrl"}; !reflect.DeepEqual(ev.Modifiers, want) {
		t.Fatalf("modifiers = %v, want %v", ev.Modifiers, want)
	}
}

// A key_up without a code clears the name-keyed entry only. A code-keyed
// entry for the same name is released again at reset: one extra key_up is
// harmless, a missed one is a stuck key.
func TestHeldInputKeyUpWithoutCodeKeepsCodeEntry(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "control", Code: "ControlRight"}, nil)
	h.observe(InputEvent{Type: "key_up", Key: "control"}, nil)
	want := []InputEvent{{Type: "key_up", Key: "ctrl", Code: "ControlRight"}}
	if got := h.releases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %+v, want %+v", got, want)
	}
}

// W2c buttons are held and released like the others.
func TestHeldInputReleasesBackForward(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "mouse_down", X: 1, Y: 2, Button: "back"}, nil)
	h.observe(InputEvent{Type: "mouse_down", X: 1, Y: 2, Button: "Forward"}, nil)
	want := []InputEvent{
		{Type: "mouse_up", X: 1, Y: 2, Button: "back"},
		{Type: "mouse_up", X: 1, Y: 2, Button: "forward"},
	}
	if got := h.releases(); !reflect.DeepEqual(got, want) {
		t.Fatalf("releases = %+v, want %+v", got, want)
	}
}

// Lock keys by code are toggles too.
func TestHeldInputDoesNotTrackLockKeysByCode(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "capslock", Code: "CapsLock"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "numlock", Code: "NumLock"}, nil)
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
}
