package desktop

import (
	"reflect"
	"testing"
)

// modifierResettingRecorder is a workerRecorder whose platform can also clear
// modifier state the OS holds outside any held record (macOS, Windows).
type modifierResettingRecorder struct {
	workerRecorder
}

func (h *modifierResettingRecorder) ResetModifierState() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, "reset_modifiers")
	return nil
}

// Issue #9595, Mac viewer → Windows, Cmd+R with Cmd↔Ctrl remapped: the
// viewer holds Ctrl, then sends the chord as key_press r [ctrl]. The agent
// keeps the held Ctrl out of the chord (K5), so Ctrl is still down on the
// remote after it. "Release stuck keys" must release it even when the viewer
// no longer lists it and the session is on legacy input.
func TestReleaseHeldInputRequestReleasesModifierAChordLeftHeld(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"key_down","key":"ctrl"}`))
	s.handleInputMessage([]byte(`{"type":"key_press","key":"r","modifiers":["ctrl"]}`))
	s.safeInput().sync()

	s.handleControlMessage([]byte(`{"type":"release_held_input"}`))

	want := []string{"key_down:ctrl", "key_press:r:", "key_up:ctrl"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
}

func TestReleaseHeldInputRequestAlsoResetsOSModifierState(t *testing.T) {
	inner := &modifierResettingRecorder{}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	s := &Session{id: "session-1", inputHandler: si}
	s.handleInputMessage([]byte(`{"type":"key_down","key":"shift"}`))
	si.sync()

	s.handleControlMessage([]byte(`{"type":"release_held_input"}`))

	want := []string{"key_down:shift", "key_up:shift", "reset_modifiers"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
}

// Only the operator's explicit request touches OS modifier state: a
// disconnect must not post modifier releases over keys the person at the
// remote machine may be holding.
func TestAutomaticReleaseDoesNotResetOSModifierState(t *testing.T) {
	inner := &modifierResettingRecorder{}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	s := &Session{id: "session-1", inputHandler: si}

	s.onViewerDataChannelClosed("input")
	si.sync()

	for _, c := range inner.snapshot() {
		if c == "reset_modifiers" {
			t.Fatalf("automatic release reset OS modifier state: %v", inner.snapshot())
		}
	}
}

func TestInputCapabilitiesAdvertiseReleaseOnRequest(t *testing.T) {
	s, _ := newSafeSession(t)
	if got := s.inputCapabilities()["releaseHeldOnRequest"]; got != true {
		t.Fatalf("releaseHeldOnRequest = %v, want true", got)
	}
	plain := &Session{id: "s", inputHandler: &stubInputHandler{}}
	if _, ok := plain.inputCapabilities()["releaseHeldOnRequest"]; ok {
		t.Fatal("a session without the input worker cannot honour release_held_input")
	}
}

func TestReleaseHeldInputRequestToleratesPlainHandler(t *testing.T) {
	s := &Session{id: "s", inputHandler: &stubInputHandler{}}
	s.handleControlMessage([]byte(`{"type":"release_held_input"}`))
}
