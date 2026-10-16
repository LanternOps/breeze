package desktop

import (
	"reflect"
	"sync"
	"testing"
)

// eventRecorder keeps every event the platform handler receives, whole, so
// the W2c fields (and their absence) can be asserted.
type eventRecorder struct {
	stubInputHandler
	mu     sync.Mutex
	events []InputEvent
}

func (h *eventRecorder) HandleEvent(ev InputEvent) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, ev)
	return nil
}

func (h *eventRecorder) snapshot() []InputEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]InputEvent(nil), h.events...)
}

func newEventSession(t *testing.T) (*Session, *eventRecorder) {
	t.Helper()
	inner := &eventRecorder{}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	return &Session{id: "session-1", inputHandler: si}, inner
}

func TestInputCapabilitiesAdvertiseKeyCodes(t *testing.T) {
	s, _ := newEventSession(t)
	if got := s.inputCapabilities()["keyCodes"]; got != true {
		t.Fatalf("keyCodes = %v, want true", got)
	}
	// keyCodes rides with reliableInput: the viewer sends the W2c fields only
	// in reliable mode, and a session without the input worker has neither.
	plain := &Session{id: "p", inputHandler: &stubInputHandler{}}
	if _, ok := plain.inputCapabilities()["keyCodes"]; ok {
		t.Fatal("advertised keyCodes without an input worker")
	}
}

// An old viewer's stream (no code, numLock, deltaX, back/forward; legacy
// channel, no seq) reaches the platform handler exactly as it did before W2c,
// releases included. The platform-level half of this guarantee is the
// *LegacyUnchanged tests (input_keycode_test.go, input_pointer_test.go,
// input_macflags_test.go, input_locksync_test.go).
func TestLegacyViewerStreamUnchanged(t *testing.T) {
	s, inner := newEventSession(t)
	on := true
	for _, raw := range []string{
		`{"type":"key_down","key":"shift","capsLock":true}`,
		`{"type":"key_press","key":"a","modifiers":["shift","ctrl"],"capsLock":true}`,
		`{"type":"mouse_down","x":10,"y":20,"button":"right"}`,
		`{"type":"mouse_scroll","x":10,"y":20,"delta":3}`,
		`{"type":"mouse_click","x":11,"y":21,"button":"middle"}`,
	} {
		s.handleInputMessage([]byte(raw))
	}
	s.onViewerDataChannelClosed("input")

	want := []InputEvent{
		{Type: "key_down", Key: "shift", CapsLock: &on},
		// K5 (W2a): the held shift is not re-pressed inside the chord.
		{Type: "key_press", Key: "a", Modifiers: []string{"ctrl"}, CapsLock: &on},
		{Type: "mouse_down", X: 10, Y: 20, Button: "right"},
		{Type: "mouse_scroll", X: 10, Y: 20, Delta: 3},
		{Type: "mouse_click", X: 11, Y: 21, Button: "middle"},
		// Channel close releases: buttons first, then keys, by name only.
		{Type: "mouse_up", X: 11, Y: 21, Button: "right"},
		{Type: "key_up", Key: "shift"},
	}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("legacy stream:\n got %+v\nwant %+v", got, want)
	}
}

// A W2c viewer's fields reach the platform handler, and a reset releases the
// back button and the right Ctrl it pressed — the right Ctrl by its code.
func TestW2cFieldsReachHandlerAndRelease(t *testing.T) {
	s, inner := newEventSession(t)
	sendR(s, rHandshake)
	for _, raw := range []string{
		`{"type":"key_down","key":"ctrl","code":"ControlRight","numLock":true,"capsLock":false,"seq":2,"epoch":1}`,
		`{"type":"mouse_down","x":5,"y":6,"button":"back","seq":3,"epoch":1,"geoEpoch":1}`,
		`{"type":"mouse_scroll","x":5,"y":6,"delta":0,"deltaX":-2,"seq":4,"epoch":1,"geoEpoch":1}`,
	} {
		sendR(s, raw)
	}
	s.onViewerDataChannelClosed("input-r")

	on, off := true, false
	got := inner.snapshot()
	want := []InputEvent{
		{Type: "key_down", Key: "ctrl", Code: "ControlRight", NumLock: &on, CapsLock: &off, Seq: 2, Epoch: 1},
		{Type: "mouse_down", X: 5, Y: 6, Button: "back", Seq: 3, Epoch: 1, GeoEpoch: 1},
		{Type: "mouse_scroll", X: 5, Y: 6, DeltaX: -2, Seq: 4, Epoch: 1, GeoEpoch: 1},
		{Type: "mouse_up", X: 5, Y: 6, Button: "back"},
		{Type: "key_up", Key: "ctrl", Code: "ControlRight"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("W2c stream:\n got %+v\nwant %+v", got, want)
	}
}

// Untrusted W2c values are dropped before the platform handler.
func TestW2cInvalidFieldsDropped(t *testing.T) {
	s, inner := newEventSession(t)
	sendR(s, rHandshake)
	for _, raw := range []string{
		`{"type":"key_down","key":"a","code":"Key A","seq":2,"epoch":1}`,
		`{"type":"key_down","key":"a","code":"KeyAKeyAKeyAKeyAKeyAKeyAKeyAKeyAK","seq":3,"epoch":1}`,
		`{"type":"mouse_scroll","x":1,"y":1,"deltaX":121,"seq":4,"epoch":1,"geoEpoch":1}`,
		`{"type":"mouse_down","x":1,"y":1,"button":"thumb","seq":5,"epoch":1,"geoEpoch":1}`,
		`{"type":"key_down","key":"a","numLock":"yes","seq":6,"epoch":1}`,
	} {
		sendR(s, raw)
	}
	s.safeInput().sync()
	if got := inner.snapshot(); len(got) != 0 {
		t.Fatalf("invalid W2c input reached the handler: %+v", got)
	}
}
