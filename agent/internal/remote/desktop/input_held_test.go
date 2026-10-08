package desktop

import (
	"errors"
	"reflect"
	"testing"
)

func TestHeldInputReleasesEverythingHeld(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "a"}, nil)
	h.observe(InputEvent{Type: "mouse_down", X: 40, Y: 50, Button: "left"}, nil)
	h.observe(InputEvent{Type: "mouse_move", X: 60, Y: 70}, nil)

	got := h.releases()
	want := []InputEvent{
		// Buttons first: a shift-drag must end as a shift-drag.
		{Type: "mouse_up", X: 60, Y: 70, Button: "left"},
		{Type: "key_up", Key: "a"},
		{Type: "key_up", Key: "shift"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("releases:\n got %+v\nwant %+v", got, want)
	}
	if again := h.releases(); len(again) != 0 {
		t.Fatalf("second releases() should be empty, got %+v", again)
	}
}

func TestHeldInputForgetsReleasedKeys(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "Shift"}, nil)
	h.observe(InputEvent{Type: "key_up", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "mouse_down", Button: ""}, nil) // "" means left
	h.observe(InputEvent{Type: "mouse_up", Button: "left"}, nil)
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
}

func TestHeldInputDoesNotTrackFailedPress(t *testing.T) {
	// The macOS agent rejects a standalone modifier key_down. It is not held
	// on the remote, so it must not be released or filtered later.
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, errors.New("unknown key"))
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
	ev := h.prepare(InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"shift"}})
	if !reflect.DeepEqual(ev.Modifiers, []string{"shift"}) {
		t.Fatalf("modifiers = %v, want [shift]", ev.Modifiers)
	}
}

func TestHeldInputDoesNotTrackLockKeys(t *testing.T) {
	h := newHeldInput()
	for _, k := range []string{"capslock", "numlock", "scrolllock"} {
		h.observe(InputEvent{Type: "key_down", Key: k}, nil)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("lock keys are toggles, not held: count = %d", n)
	}
}

func TestHeldInputPrepareDropsHeldModifiersFromKeyPress(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "control"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "meta"}, nil)

	ev := h.prepare(InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"ctrl", "shift", "alt", "meta"}})

	// ctrl and shift are already down: re-pressing them inside key_press would
	// release them on the way out (spec K5). alt is not held, so it stays.
	// meta stays: in key_press the Windows agent injects it as Ctrl, while a
	// held meta is the Win key, so they are not the same key.
	if want := []string{"alt", "meta"}; !reflect.DeepEqual(ev.Modifiers, want) {
		t.Fatalf("modifiers = %v, want %v", ev.Modifiers, want)
	}
}

func TestHeldInputPrepareLeavesOtherEventsAlone(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	in := InputEvent{Type: "key_down", Key: "a", Modifiers: []string{"shift"}}
	if got := h.prepare(in); !reflect.DeepEqual(got, in) {
		t.Fatalf("prepare changed a non-key_press event: %+v", got)
	}
}
