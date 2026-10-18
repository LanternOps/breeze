package desktop

import (
	"reflect"
	"testing"
)

// A key_up resolves to the key its key_down pressed, so the platform handler
// releases the same physical key and the record is cleared only for it.

// Shift pressed after Digit1: the browser's key_up says "!" but the code is
// still Digit1. Released as "!" the Windows VK lookup fails, the key stays
// down, and the record (keyed by code) would be forgotten. prepare puts the
// pressing key name back.
func TestHeldInputKeyUpUsesPressedKeyName(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "1", Code: "Digit1"}, nil)
	got := h.prepare(InputEvent{Type: "key_up", Key: "!", Code: "Digit1"})
	if want := (InputEvent{Type: "key_up", Key: "1", Code: "Digit1"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("prepare = %+v, want %+v", got, want)
	}
}

// Pressed by code, released without one: release by the pressing code, or
// Windows would release VK_CONTROL (left Ctrl) and leave right Ctrl down.
func TestHeldInputKeyUpWithoutCodeUsesPressedCode(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "control", Code: "ControlRight"}, nil)
	got := h.prepare(InputEvent{Type: "key_up", Key: "ctrl"})
	if got.Code != "ControlRight" {
		t.Fatalf("prepare = %+v, want code ControlRight", got)
	}
	h.observe(got, nil)
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
}

// Pressed without a code, released with one: release the way it was pressed.
func TestHeldInputKeyUpWithUnpressedCodeDropsCode(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "ctrl"}, nil)
	got := h.prepare(InputEvent{Type: "key_up", Key: "ctrl", Code: "ControlRight"})
	if got.Code != "" {
		t.Fatalf("prepare = %+v, want no code", got)
	}
	h.observe(got, nil)
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
}

// Legacy key_up (no codes anywhere) is untouched.
func TestHeldInputLegacyKeyUpUnchanged(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "1"}, nil)
	in := InputEvent{Type: "key_up", Key: "!"}
	if got := h.prepare(in); !reflect.DeepEqual(got, in) {
		t.Fatalf("legacy key_up changed: %+v", got)
	}
	in = InputEvent{Type: "key_up", Key: "Shift"}
	if got := h.prepare(in); !reflect.DeepEqual(got, in) {
		t.Fatalf("legacy key_up changed: %+v", got)
	}
}

// Lock-key suppression is only for a lock whose state the platform can read
// and set; otherwise the key itself must still be injected.
func TestLockSyncPlanSuppressesNamedLock(t *testing.T) {
	on := true
	p := lockSyncFor(InputEvent{Type: "key_down", Key: "numlock", Seq: 2, NumLock: &on})
	if !p.suppressKey || p.keyLock != lockNum {
		t.Fatalf("plan = %+v, want suppress num", p)
	}
	p = lockSyncFor(InputEvent{Type: "key_down", Key: "capslock", Seq: 2, CapsLock: &on})
	if !p.suppressKey || p.keyLock != lockCaps {
		t.Fatalf("plan = %+v, want suppress caps", p)
	}
}
