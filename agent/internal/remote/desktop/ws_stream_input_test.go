package desktop

import "testing"

func TestWsStreamStopReleasesHeldInput(t *testing.T) {
	inner := &workerRecorder{}
	s := newWsStreamSession("ws-1", nil, NewSafeInput(inner, "ws-1"), nil, StreamConfig{})
	s.skipWallpaper = true

	if err := s.HandleInput(InputEvent{Type: "key_down", Key: "shift"}); err != nil {
		t.Fatal(err)
	}
	s.Stop()

	if got := lastCall(inner); got != "key_up:shift" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}
