package desktop

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestIsCopyChordEvent(t *testing.T) {
	cases := []struct {
		name string
		held []string // key_downs already injected
		ev   InputEvent
		want bool
	}{
		{"ctrl+c key_press", nil, InputEvent{Type: "key_press", Key: "c", Modifiers: []string{"ctrl"}}, true},
		{"ctrl+C shifted name", nil, InputEvent{Type: "key_press", Key: "C", Modifiers: []string{"ctrl", "shift"}}, true},
		{"cmd+c on a Mac remote", nil, InputEvent{Type: "key_press", Key: "c", Modifiers: []string{"meta"}}, true},
		{"ctrl+x cut", nil, InputEvent{Type: "key_press", Key: "x", Modifiers: []string{"ctrl"}}, true},
		{"ctrl+insert", nil, InputEvent{Type: "key_press", Key: "insert", Modifiers: []string{"ctrl"}}, true},
		{"by physical code", nil, InputEvent{Type: "key_press", Key: "ç", Code: "KeyC", Modifiers: []string{"ctrl"}}, true},
		{"held ctrl then key_down c", []string{"ctrl"}, InputEvent{Type: "key_down", Key: "c"}, true},
		{"held control alias", []string{"Control"}, InputEvent{Type: "key_down", Key: "x"}, true},
		{"key_press with ctrl already held (stripped by prepare)", []string{"ctrl"}, InputEvent{Type: "key_press", Key: "c", Modifiers: []string{"ctrl"}}, true},
		{"plain c", nil, InputEvent{Type: "key_down", Key: "c"}, false},
		{"plain c key_press", nil, InputEvent{Type: "key_press", Key: "c"}, false},
		{"ctrl+v paste", nil, InputEvent{Type: "key_press", Key: "v", Modifiers: []string{"ctrl"}}, false},
		{"ctrl+alt+c (AltGr)", nil, InputEvent{Type: "key_press", Key: "c", Modifiers: []string{"ctrl", "alt"}}, false},
		{"shift+insert pastes", nil, InputEvent{Type: "key_press", Key: "insert", Modifiers: []string{"shift"}}, false},
		{"ctrl+shift+insert", nil, InputEvent{Type: "key_press", Key: "insert", Modifiers: []string{"ctrl", "shift"}}, false},
		{"key_up c with ctrl held", []string{"ctrl"}, InputEvent{Type: "key_up", Key: "c"}, false},
		{"mouse click", nil, InputEvent{Type: "mouse_click", Button: "left"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHeldInput()
			for _, k := range tc.held {
				h.observe(InputEvent{Type: "key_down", Key: k}, nil)
			}
			if got := h.isCopyChord(tc.ev); got != tc.want {
				t.Fatalf("isCopyChord(%+v) with held %v = %v, want %v", tc.ev, tc.held, got, tc.want)
			}
		})
	}
}

// The copy-chord hook fires after the chord was injected, and only then.
func TestSafeInputFiresCopyChordHookAfterInjection(t *testing.T) {
	rec := &workerRecorder{failKey: "x"}
	s := NewSafeInput(rec, "test")
	defer s.Close()
	var fired atomic.Int32
	s.SetHooks(safeInputHooks{onCopyChord: func() { fired.Add(1) }})

	steps := []struct {
		ev   InputEvent
		want int32
	}{
		{InputEvent{Type: "key_press", Key: "v", Modifiers: []string{"ctrl"}}, 0},
		{InputEvent{Type: "key_press", Key: "c", Modifiers: []string{"ctrl"}}, 1},
		{InputEvent{Type: "key_down", Key: "ctrl"}, 1},
		{InputEvent{Type: "key_down", Key: "c"}, 2},
		{InputEvent{Type: "key_up", Key: "c"}, 2},
		// A chord the platform failed to inject copied nothing.
		{InputEvent{Type: "key_down", Key: "x"}, 2},
	}
	for i, st := range steps {
		_ = s.HandleEvent(st.ev)
		if got := fired.Load(); got != st.want {
			t.Fatalf("step %d (%+v): hook fired %d time(s), want %d", i, st.ev, got, st.want)
		}
	}
}

// The session forwards the hook to the clipboard watcher without waiting on
// the session lock (it runs on the input worker).
func TestSessionCopyChordReachesClipboard(t *testing.T) {
	cs := &copyChordRecorder{}
	s := &Session{id: "copy-chord"}
	s.clipboardNotifier = cs
	s.mu.Lock() // a holder of Session.mu must not stall the input worker
	done := make(chan struct{})
	go func() { s.onCopyChordInjected(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("onCopyChordInjected waited on Session.mu")
	}
	s.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for cs.n.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("copy chord never reached the clipboard watcher")
		}
		time.Sleep(time.Millisecond)
	}
}

type copyChordRecorder struct{ n atomic.Int32 }

func (c *copyChordRecorder) CopyChordInjected() { c.n.Add(1) }
