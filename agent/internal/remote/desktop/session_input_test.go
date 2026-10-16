package desktop

import (
	"encoding/json"
	"testing"
)

func newSafeSession(t *testing.T) (*Session, *workerRecorder) {
	t.Helper()
	inner := &workerRecorder{}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	return &Session{id: "session-1", inputHandler: si}, inner
}

func lastCall(h *workerRecorder) string {
	c := h.snapshot()
	if len(c) == 0 {
		return ""
	}
	return c[len(c)-1]
}

func TestSessionReleasesHeldKeyWhenInputChannelCloses(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"key_down","key":"shift"}`))

	s.onViewerDataChannelClosed("input")

	if got := lastCall(inner); got != "key_up:shift" {
		t.Fatalf("last call = %q, want key_up:shift (all: %v)", got, inner.snapshot())
	}
}

func TestSessionReleasesHeldButtonOnPeerDisconnect(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"mouse_down","x":3,"y":4,"button":"left"}`))

	s.onPeerDisconnected()

	if got := lastCall(inner); got != "mouse_up:3,4:left" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestSessionCleanupReleasesHeldInput(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"key_down","key":"ctrl"}`))

	s.doCleanup()

	if got := lastCall(inner); got != "key_up:ctrl" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestSessionTypeTextGoesThroughTheWorker(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleControlMessage([]byte(`{"type":"type_text","text":"hi"}`))
	if len(inner.texts) != 1 || inner.texts[0] != "hi" {
		t.Fatalf("texts = %v", inner.texts)
	}
}

func TestSessionHelpersToleratePlainHandler(t *testing.T) {
	// Existing tests build sessions around plain stubs; the helpers must not panic.
	s := &Session{id: "s", inputHandler: &stubInputHandler{}}
	s.releaseHeldInput("test")
	s.onViewerDataChannelClosed("input")
	s.onPeerDisconnected()
	s.closeInput()
}

func TestInputCapabilitiesAdvertiseHeldInputRelease(t *testing.T) {
	var body map[string]any
	raw, _ := json.Marshal(buildInputCapabilities())
	_ = json.Unmarshal(raw, &body)
	if body["releasesHeldInput"] != true {
		t.Fatalf("capabilities = %s", raw)
	}
}
