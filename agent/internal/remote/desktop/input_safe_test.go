package desktop

import (
	"errors"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"
)

// workerRecorder is a thread-safe InputHandler that records every call in
// order. block, when non-nil, stalls HandleEvent until closed; entered (when
// non-nil, buffered) is signalled as each HandleEvent call begins, so a test
// can wait until the worker is actually wedged instead of sleeping.
type workerRecorder struct {
	stubInputHandler
	mu      sync.Mutex
	calls   []string
	failKey string
	block   chan struct{}
	entered chan struct{}
	texts   []string
}

func newBlockingRecorder() *workerRecorder {
	return &workerRecorder{block: make(chan struct{}), entered: make(chan struct{}, 64)}
}

func (h *workerRecorder) HandleEvent(ev InputEvent) error {
	if h.entered != nil {
		h.entered <- struct{}{}
	}
	if h.block != nil {
		<-h.block
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	switch ev.Type {
	case "key_press":
		h.calls = append(h.calls, ev.Type+":"+ev.Key+":"+joinMods(ev.Modifiers))
	case "key_down", "key_up":
		h.calls = append(h.calls, ev.Type+":"+ev.Key)
	default:
		h.calls = append(h.calls, ev.Type+":"+itoa(ev.X)+","+itoa(ev.Y)+":"+ev.Button)
	}
	if ev.Key != "" && ev.Key == h.failKey {
		return errors.New("unknown key")
	}
	return nil
}

func (h *workerRecorder) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, "offset:"+itoa(x)+","+itoa(y))
}

func (h *workerRecorder) TypeText(text string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.texts = append(h.texts, text)
	return nil
}

func (h *workerRecorder) snapshot() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.calls...)
}

// waitFor polls cond until it holds, failing the test after 2s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// wedge parks the worker inside the platform handler on a key_down.
func wedge(t *testing.T, s *SafeInput, inner *workerRecorder, key string) {
	t.Helper()
	go func() { _ = s.HandleEvent(InputEvent{Type: "key_down", Key: key}) }()
	select {
	case <-inner.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("worker never reached the platform handler")
	}
}

func joinMods(m []string) string {
	out := ""
	for i, s := range m {
		if i > 0 {
			out += "+"
		}
		out += s
	}
	return out
}

func itoa(v int) string { return strconv.Itoa(v) }

func TestSafeInputReleaseAllReleasesHeldInput(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	mustHandle(t, s, InputEvent{Type: "key_down", Key: "shift"})
	mustHandle(t, s, InputEvent{Type: "mouse_down", X: 5, Y: 6, Button: "left"})
	s.ReleaseAll("test")

	want := []string{"key_down:shift", "mouse_down:5,6:left", "mouse_up:5,6:left", "key_up:shift"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputKeyPressKeepsHeldModifiersDown(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	mustHandle(t, s, InputEvent{Type: "key_down", Key: "shift"})
	mustHandle(t, s, InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"shift"}})

	want := []string{"key_down:shift", "key_press:a:"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputCloseReleasesAndIsIdempotent(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	mustHandle(t, s, InputEvent{Type: "key_down", Key: "ctrl"})

	s.Close()
	s.Close()

	if got := inner.snapshot(); got[len(got)-1] != "key_up:ctrl" {
		t.Fatalf("Close did not release ctrl: %v", got)
	}
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); !errors.Is(err, errInputClosed) {
		t.Fatalf("HandleEvent after Close: err=%v, want errInputClosed", err)
	}
	s.ReleaseAll("after close") // must not block or panic
}

func TestSafeInputCloseDoesNotHangOnStuckHandler(t *testing.T) {
	inner := newBlockingRecorder()
	defer close(inner.block)
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 100 * time.Millisecond
	wedge(t, s, inner, "a")

	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked on a wedged platform handler")
	}
}

func TestSafeInputMovesCoalesceAndKeepOrderWithDiscreteEvents(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()

	// Wedge the worker on a discrete event, flood moves, then a mouse_down.
	wedge(t, s, inner, "x")
	for i := 1; i <= 1000; i++ {
		_ = s.HandleEvent(InputEvent{Type: "mouse_move", X: i, Y: i})
	}
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(InputEvent{Type: "mouse_down", X: 1000, Y: 1000, Button: "left"}) }()
	waitFor(t, "the coalesced move and the mouse_down to queue", func() bool { return len(s.jobs) == 2 })
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	want := []string{"key_down:x", "mouse_move:1000,1000:", "mouse_down:1000,1000:left"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputReleaseAllDiscardsQueuedInput(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()

	wedge(t, s, inner, "x")
	queued := make(chan error, 1)
	go func() { queued <- s.HandleEvent(InputEvent{Type: "key_down", Key: "y"}) }()
	waitFor(t, "key_down y to queue", func() bool { return len(s.jobs) == 1 })

	released := make(chan struct{})
	go func() { s.ReleaseAll("test"); close(released) }()
	waitFor(t, "the release to queue", func() bool { return len(s.urgent) == 1 })
	close(inner.block)
	<-released

	if err := <-queued; !errors.Is(err, errInputReset) {
		t.Fatalf("queued key_down: err=%v, want errInputReset", err)
	}
	for _, c := range inner.snapshot() {
		if c == "key_down:y" {
			t.Fatalf("queued key_down ran after ReleaseAll: %v", inner.snapshot())
		}
	}
}

func TestSafeInputReturnsPlatformErrors(t *testing.T) {
	inner := &workerRecorder{failKey: "bogus"}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "bogus"}); err == nil {
		t.Fatal("expected the platform error to reach the caller")
	}
}

func TestSafeInputDisplayOffsetIsOrderedWithInput(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	mustHandle(t, s, InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left"})
	s.SetDisplayOffset(1920, 0)
	mustHandle(t, s, InputEvent{Type: "mouse_up", X: 2, Y: 2, Button: "left"})
	want := []string{"mouse_down:1,1:left", "offset:1920,0", "mouse_up:2,2:left"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputInjectTextUsesInnerTextTyper(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	if err := s.InjectText("hello"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inner.texts, []string{"hello"}) {
		t.Fatalf("texts = %v", inner.texts)
	}
}

func mustHandle(t *testing.T, s *SafeInput, ev InputEvent) {
	t.Helper()
	if err := s.HandleEvent(ev); err != nil {
		t.Fatalf("HandleEvent(%+v): %v", ev, err)
	}
	if ev.Type == "mouse_move" {
		s.sync() // moves are asynchronous
	}
}

func TestSafeInputSetDisplayOffsetDoesNotWaitOnStuckWorker(t *testing.T) {
	// The capture goroutine sets the offset on a desktop switch; StopWithReason
	// waits for that goroutine before cleanup, so blocking it on a wedged
	// worker would hang session teardown for good.
	inner := newBlockingRecorder()
	defer close(inner.block)
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 50 * time.Millisecond
	defer s.Close()
	wedge(t, s, inner, "a")

	done := make(chan struct{})
	go func() { s.SetDisplayOffset(1920, 0); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SetDisplayOffset blocked on a wedged worker")
	}
}

func TestSafeInputCloseDoesNotHangWithFullUrgentQueue(t *testing.T) {
	inner := newBlockingRecorder()
	defer close(inner.block)
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 50 * time.Millisecond
	wedge(t, s, inner, "a")

	// Disconnect, channel closes, a desktop switch: each queues a release
	// that times out and is left behind in the urgent queue.
	for i := 0; i < cap(s.urgent)+2; i++ {
		go s.ReleaseAll("pileup")
	}
	waitFor(t, "the urgent queue to fill", func() bool { return len(s.urgent) == cap(s.urgent) })

	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked behind a full urgent queue")
	}
}
