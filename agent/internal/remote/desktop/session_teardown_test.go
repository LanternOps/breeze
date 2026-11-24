package desktop

import (
	"bytes"
	"image"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// #12624: one session whose capture loop never exits must not block its own
// stop, hide the stop from the API, or be torn down under the stuck loop.

// blockingCapturer blocks in Capture until released, like a capture goroutine
// stuck in a driver call, and records Close.
type blockingCapturer struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	closed  atomic.Int32
}

func newBlockingCapturer() *blockingCapturer {
	return &blockingCapturer{entered: make(chan struct{}), release: make(chan struct{})}
}

func (c *blockingCapturer) Capture() (*image.RGBA, error) {
	c.once.Do(func() { close(c.entered) })
	<-c.release
	return nil, nil
}
func (c *blockingCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return c.Capture()
}
func (c *blockingCapturer) GetScreenBounds() (int, int, error) { return 4, 4, nil }
func (c *blockingCapturer) Close() error                       { c.closed.Add(1); return nil }

// countingCapturer counts Close calls.
type countingCapturer struct {
	staticTestCapturer
	closed atomic.Int32
}

func (c *countingCapturer) Close() error { c.closed.Add(1); return nil }

// closeBlockingCapturer blocks in Close (a driver release that hangs).
type closeBlockingCapturer struct {
	staticTestCapturer
	release chan struct{}
}

func (c *closeBlockingCapturer) Close() error { <-c.release; return nil }

func shortStopBounds(t *testing.T, loops, cleanup time.Duration) {
	t.Helper()
	l, c := sessionLoopExitBound, sessionCleanupBound
	sessionLoopExitBound, sessionCleanupBound = loops, cleanup
	t.Cleanup(func() { sessionLoopExitBound, sessionCleanupBound = l, c })
}

// isolatedCaptureHealth gives the test its own process health record.
func isolatedCaptureHealth(t *testing.T) *captureProcessHealth {
	t.Helper()
	prev := captureHealth
	h := newCaptureProcessHealth()
	captureHealth = h
	t.Cleanup(func() { captureHealth = prev })
	return h
}

type lockedWriter struct {
	mu  *sync.Mutex
	buf *bytes.Buffer
}

func (w lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func captureLogs(t *testing.T) func() string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(lockedWriter{&mu, &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stuckSession starts a real ticker capture loop on a capturer that blocks.
func stuckSession(t *testing.T, id string, cap *blockingCapturer) *Session {
	t.Helper()
	s := newTestSession(id)
	s.capturer = cap
	s.fps = maxFrameRate
	s.differ = newFrameDiffer()
	s.cursor = newCursorOverlay()
	s.encoder.Store(&VideoEncoder{backend: &stubEncoder{}})
	s.runLoop("capture loop", s.captureLoop)
	select {
	case <-cap.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("capture loop never reached the capturer")
	}
	return s
}

func stopWithin(t *testing.T, limit time.Duration, stop func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(limit):
		t.Fatalf("stop did not return within %s", limit)
	}
}

// The shortest wait on a stop anywhere is the 5s desktop_stop IPC budget of
// the macOS handoff; service stops wait 10s.
func TestStopBoundsFitTheIPCBudget(t *testing.T) {
	if total := sessionLoopExitBound + sessionCleanupBound; total >= 5*time.Second {
		t.Errorf("stop may take %s, longer than the shortest desktop_stop wait", total)
	}
}

func TestStopReturnsWhenCaptureLoopIsStuck(t *testing.T) {
	shortStopBounds(t, 100*time.Millisecond, 100*time.Millisecond)
	health := isolatedCaptureHealth(t)
	logs := captureLogs(t)
	cap := newBlockingCapturer()
	s := stuckSession(t, "stuck-1", cap)
	m := &SessionManager{sessions: map[string]*Session{"stuck-1": s}}

	stopWithin(t, 3*time.Second, func() { m.StopSession("stuck-1") })

	if m.HasSession("stuck-1") || m.HasActiveSessions() {
		t.Error("a stopped session is still reported as live")
	}
	if n := cap.closed.Load(); n != 0 {
		t.Errorf("capturer closed %d times while its loop was still using it", n)
	}
	if health.poisonReason() == "" {
		t.Error("an abandoned capture loop did not mark the process as poisoned")
	}
	if health.teardownInProgress() {
		t.Error("teardown still counted after the stop returned")
	}
	out := logs()
	if !strings.Contains(out, "level=WARN") || !strings.Contains(out, "capture loop") ||
		!strings.Contains(out, "blockingCapturer") {
		t.Errorf("the warning must name the stuck stage, got:\n%s", out)
	}

	// The loop comes back late: only now may the pipeline be released, and
	// the process is clean again.
	close(cap.release)
	eventually(t, "late release", func() bool { return cap.closed.Load() == 1 && health.poisonReason() == "" })
}

// Later starts and stops must not wait on the stuck one.
func TestStuckStopDoesNotBlockAnotherSession(t *testing.T) {
	shortStopBounds(t, 100*time.Millisecond, 100*time.Millisecond)
	isolatedCaptureHealth(t)
	cap := newBlockingCapturer()
	m := &SessionManager{sessions: map[string]*Session{"stuck": stuckSession(t, "stuck", cap)}}
	stopWithin(t, 3*time.Second, func() { m.StopSession("stuck") })

	clean := &countingCapturer{}
	next := newTestSession("next")
	next.capturer = clean
	m.sessions["next"] = next
	stopWithin(t, time.Second, func() { m.StopSession("next") })
	if n := clean.closed.Load(); n != 1 {
		t.Errorf("the next session's capturer closed %d times, want 1", n)
	}
	close(cap.release)
	eventually(t, "stuck capturer released", func() bool { return cap.closed.Load() == 1 })
}

// A stuck loop may never be released, but what it pressed on the customer's
// machine must be.
func TestStuckStopStillReleasesInput(t *testing.T) {
	shortStopBounds(t, 50*time.Millisecond, 2*time.Second)
	isolatedCaptureHealth(t)
	inner := &workerRecorder{}
	si := NewSafeInput(inner, "s")
	cap := newBlockingCapturer()
	s := stuckSession(t, "s", cap)
	s.inputHandler = si
	if err := si.HandleEvent(InputEvent{Type: "key_down", Key: "alt"}); err != nil {
		t.Fatal(err)
	}
	stopWithin(t, 5*time.Second, s.Stop)
	released := false
	for _, c := range inner.snapshot() {
		released = released || c == "key_up:alt"
	}
	if !released {
		t.Errorf("held key not released: %v", inner.snapshot())
	}
	close(cap.release)
	eventually(t, "stuck capturer released", func() bool { return cap.closed.Load() == 1 })
}

func TestStopReturnsWhenCapturerCloseIsStuck(t *testing.T) {
	shortStopBounds(t, time.Second, 100*time.Millisecond)
	health := isolatedCaptureHealth(t)
	logs := captureLogs(t)
	c := &closeBlockingCapturer{release: make(chan struct{})}
	s := newTestSession("s")
	s.capturer = c
	stopWithin(t, 3*time.Second, s.Stop)
	if health.poisonReason() == "" {
		t.Error("a capturer that cannot be closed must mark the process poisoned")
	}
	if out := logs(); !strings.Contains(out, "level=WARN") || !strings.Contains(out, "close capturer") {
		t.Errorf("warning does not name the stuck stage:\n%s", out)
	}
	close(c.release)
	eventually(t, "late cleanup to clear the mark", func() bool { return health.poisonReason() == "" })
}

func TestNormalStopClosesPipelineOnceAndLeavesProcessClean(t *testing.T) {
	health := isolatedCaptureHealth(t)
	c := &countingCapturer{}
	s := newTestSession("s")
	s.capturer = c
	s.Stop()
	s.doCleanup()
	if n := c.closed.Load(); n != 1 {
		t.Errorf("capturer closed %d times, want 1", n)
	}
	if r := health.poisonReason(); r != "" {
		t.Errorf("normal stop marked the process poisoned: %q", r)
	}
	if health.teardownInProgress() {
		t.Error("teardown still counted after a normal stop")
	}
}

// A start that is still opening its capturer when the session stops used to
// install it after cleanup had run: nothing ever closed it, so its
// duplication outlived the session.
func TestCapturerOpenedAfterStopIsClosedNotInstalled(t *testing.T) {
	isolatedCaptureHealth(t)
	late := &countingCapturer{}
	s := newTestSession("s")
	s.Stop()
	if s.installCapturer(late) {
		t.Fatal("a stopped session accepted a new capturer")
	}
	if n := late.closed.Load(); n != 1 {
		t.Errorf("late capturer closed %d times, want 1", n)
	}
}

// The same for a monitor switch that loses the race with stop.
func TestSwapCapturerAfterStopClosesNewCapturer(t *testing.T) {
	isolatedCaptureHealth(t)
	first, late := &countingCapturer{}, &countingCapturer{}
	s := newTestSession("s")
	s.capturer = first
	s.Stop()
	if s.swapCapturer(late, 1, CaptureConfig{DisplayIndex: 1}) {
		t.Fatal("a stopped session accepted a monitor switch")
	}
	if late.closed.Load() != 1 || first.closed.Load() != 1 {
		t.Errorf("closed: late=%d first=%d, want 1 each", late.closed.Load(), first.closed.Load())
	}
}

func TestSwapCapturerKeepsOldForTheLoopToClose(t *testing.T) {
	first, next := &countingCapturer{}, &countingCapturer{}
	s := newTestSession("s")
	s.capturer = first
	if !s.swapCapturer(next, 1, CaptureConfig{DisplayIndex: 1}) {
		t.Fatal("live session refused a monitor switch")
	}
	if s.capturer != ScreenCapturer(next) || len(s.oldCapturers) != 1 || s.displayIndex != 1 || first.closed.Load() != 0 {
		t.Errorf("swap state wrong: old=%d display=%d closed=%d", len(s.oldCapturers), s.displayIndex, first.closed.Load())
	}
}

// While a stop is still running the process is busy: replacing it then would
// lose the stop's own reply.
func TestTeardownInProgressWhileStopping(t *testing.T) {
	shortStopBounds(t, 2*time.Second, time.Second)
	health := isolatedCaptureHealth(t)
	cap := newBlockingCapturer()
	s := stuckSession(t, "s", cap)
	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	eventually(t, "teardown counted", health.teardownInProgress)
	close(cap.release)
	<-done
	if health.teardownInProgress() {
		t.Error("teardown still counted after the stop returned")
	}
}
