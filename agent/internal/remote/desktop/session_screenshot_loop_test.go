package desktop

import (
	"bytes"
	"errors"
	"image"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// goroutineID returns the current goroutine's id, parsed from runtime.Stack.
// Test-only: the fakes below use it to tell the capture loop's goroutine
// apart from the screenshot caller's. A parse failure returns -1, which never
// matches the loop's id, so it fails a test loudly rather than passing it.
func goroutineID() int64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	fields := bytes.Fields(buf[:n]) // "goroutine 123 [running]:"
	if len(fields) < 2 {
		return -1
	}
	id, err := strconv.ParseInt(string(fields[1]), 10, 64)
	if err != nil {
		return -1
	}
	return id
}

// heldFrameCapturer models the Windows DXGI capturer on the GPU encode path
// (#12624): CaptureTexture acquires a duplication frame that stays held until
// ReleaseTexture, and the capturer mutex is not held in between. A Capture()
// in that window is what reaches AcquireNextFrame with a frame outstanding
// (DXGI_ERROR_INVALID_CALL), which the real capturer answers by tearing the
// device down. The fake records that instead, and any Capture() made from a
// goroutine other than the capture loop's.
type heldFrameCapturer struct {
	held      atomic.Bool
	loopGID   atomic.Int64
	textures  atomic.Int64
	captures  atomic.Int64
	offThread atomic.Int64 // Capture() from a goroutine other than the loop
	whileHeld atomic.Int64 // Capture() while a texture frame was held (teardown)
	nilFrames atomic.Int64 // Capture() calls left to answer with "no new frame"
	tight     atomic.Bool  // TightLoop(): DXGI loop when true, ticker when false
	gpu       atomic.Bool  // CaptureTexture delivers frames (else: idle screen)
	panicNow  atomic.Bool  // next Capture() panics (models a capture-loop crash)

	// gate, when set, makes Capture() report entry on entered and then wait
	// until gate is closed.
	gate, entered chan struct{}
}

func newHeldFrameCapturer(tight, gpu bool) *heldFrameCapturer {
	c := &heldFrameCapturer{}
	c.tight.Store(tight)
	c.gpu.Store(gpu)
	return c
}

func (c *heldFrameCapturer) Capture() (*image.RGBA, error) {
	c.captures.Add(1)
	if gid := c.loopGID.Load(); gid != 0 && goroutineID() != gid {
		c.offThread.Add(1)
	}
	if c.gate != nil {
		c.entered <- struct{}{}
		<-c.gate
	}
	if c.panicNow.Swap(false) {
		panic("capturer crashed")
	}
	if c.held.Load() {
		c.whileHeld.Add(1)
		return nil, errors.New("AcquireNextFrame: DXGI_ERROR_INVALID_CALL (frame still held)")
	}
	if c.nilFrames.Load() > 0 {
		c.nilFrames.Add(-1)
		return nil, nil
	}
	return image.NewRGBA(image.Rect(0, 0, 8, 4)), nil
}

func (c *heldFrameCapturer) CaptureRegion(x, y, w, h int) (*image.RGBA, error) {
	return c.Capture()
}
func (c *heldFrameCapturer) GetScreenBounds() (int, int, error) { return 8, 4, nil }
func (c *heldFrameCapturer) Close() error                       { return nil }
func (c *heldFrameCapturer) TightLoop() bool                    { return c.tight.Load() }

func (c *heldFrameCapturer) CaptureTexture() (uintptr, error) {
	c.loopGID.CompareAndSwap(0, goroutineID())
	c.textures.Add(1)
	if !c.gpu.Load() {
		return 0, nil // idle: no new frame
	}
	if c.held.Swap(true) {
		return 0, errors.New("previous DXGI frame not released")
	}
	return 1, nil
}
func (c *heldFrameCapturer) ReleaseTexture()          { c.held.Store(false) }
func (c *heldFrameCapturer) GetD3D11Device() uintptr  { return 0 }
func (c *heldFrameCapturer) GetD3D11Context() uintptr { return 0 }

// gpuStubEncoder is a zero-copy GPU encoder backend whose EncodeTexture takes
// a moment, so the capture loop holds its frame for most of each iteration.
type gpuStubEncoder struct{ stubEncoder }

func (e *gpuStubEncoder) SupportsGPUInput() bool { return true }
func (e *gpuStubEncoder) EncodeTexture(uintptr) ([]byte, error) {
	time.Sleep(3 * time.Millisecond)
	return []byte{0, 0, 0, 1, 0x41, 0x9a}, nil
}

// newLoopTestSession builds a session the real capture loop can run against
// with the fakes above, registered in a SessionManager on display 0.
func newLoopTestSession(t *testing.T, cap ScreenCapturer, backend encoderBackend) (*SessionManager, *Session) {
	t.Helper()
	s := &Session{id: "shot", isActive: true, done: make(chan struct{}), fps: defaultFrameRate}
	s.capturer = cap
	s.encoder.Store(&VideoEncoder{backend: backend})
	s.metrics = newStreamMetrics()
	s.differ = newFrameDiffer()
	s.cursor = newCursorOverlay()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "test")
	if err != nil {
		t.Fatal(err)
	}
	s.videoTrack = track
	m := &SessionManager{sessions: map[string]*Session{s.id: s}}
	return m, s
}

// longScreenshotTimeout keeps tests that expect success clear of the request
// timeout on a loaded -race CI host.
func longScreenshotTimeout(t *testing.T) {
	prev := screenshotRequestTimeout
	screenshotRequestTimeout = 10 * time.Second
	t.Cleanup(func() { screenshotRequestTimeout = prev })
}

// runLoop starts the real capture loop and returns a func that stops it and
// waits for it to exit. exited closes when the loop returns, also on a panic
// (recovered here, as the session's own goroutine does before re-raising).
func runLoop(t *testing.T, s *Session) (stop func(), exited <-chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		if c, ok := s.capturer.(*heldFrameCapturer); ok {
			c.loopGID.Store(goroutineID()) // captureLoop runs on this goroutine
		}
		s.captureLoop()
	}()
	var once atomic.Bool
	return func() {
		if once.Swap(true) {
			return
		}
		close(s.done)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("capture loop did not exit after done was closed")
		}
	}, done
}

func waitForShot(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// assertServedOnLoop checks that no capture ran off the loop's goroutine and
// none ran while the stream held a frame.
func assertServedOnLoop(t *testing.T, cap *heldFrameCapturer) {
	t.Helper()
	if n := cap.offThread.Load(); n != 0 {
		t.Errorf("Capture() ran %d times off the capture loop's goroutine; the loop must serve screenshots", n)
	}
	if n := cap.whileHeld.Load(); n != 0 {
		t.Errorf("Capture() ran %d times while the stream held a DXGI frame (would tear the device down)", n)
	}
}

// #12624: a one-shot screenshot during a live GPU-path session must not drive
// the capturer from the caller's goroutine. On main it called Capture() there,
// which lands while the stream holds its DXGI frame and tears the device down.
func TestCaptureScreenshot_GPUStreamServedByCaptureLoop(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(true, true)
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()

	waitForShot(t, "the stream to encode frames", func() bool { return cap.textures.Load() > 5 })

	for i := 0; i < 5; i++ {
		img, w, h, err := m.CaptureScreenshot(0)
		if err != nil {
			t.Fatalf("screenshot %d: %v", i, err)
		}
		if img == nil || w != 8 || h != 4 {
			t.Fatalf("screenshot %d = (%v, %d, %d), want an 8x4 frame", i, img, w, h)
		}
	}
	stop()
	assertServedOnLoop(t, cap)
}

// Idle GPU stream: CaptureTexture reports no new frame and the first captures
// see none either (a static screen). The request survives the empty attempts
// and is answered when a frame arrives.
func TestCaptureScreenshot_IdleStreamRetriesOnLoop(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(true, false)
	cap.nilFrames.Store(3)
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()
	waitForShot(t, "the idle stream to poll", func() bool { return cap.textures.Load() > 2 })

	img, w, h, err := m.CaptureScreenshot(0)
	if err != nil || img == nil || w != 8 || h != 4 {
		t.Fatalf("CaptureScreenshot = (%v, %d, %d, %v), want an 8x4 frame", img, w, h, err)
	}
	if got := cap.captures.Load(); got < 4 {
		t.Errorf("captures = %d, want at least 4 (three empty attempts, then the frame)", got)
	}
	stop()
	assertServedOnLoop(t, cap)
}

// CPU capture path (ticker loop: GDI fallback, secure desktop, Linux): the
// ticker loop serves the request too.
func TestCaptureScreenshot_TickerLoopServesRequest(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(false, false)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()
	waitForShot(t, "the ticker loop to capture", func() bool { return cap.captures.Load() > 1 })

	img, _, _, err := m.CaptureScreenshot(0)
	if err != nil || img == nil {
		t.Fatalf("CaptureScreenshot = (%v, %v), want a frame", img, err)
	}
	stop()
	assertServedOnLoop(t, cap)
}

// A request pending when the DXGI loop hands over to the ticker loop (DXGI
// falling back to GDI) is still answered: the queue belongs to the session,
// not to either loop.
func TestCaptureScreenshot_RequestSurvivesLoopModeSwitch(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(true, false)
	cap.nilFrames.Store(1 << 30) // no frame while the DXGI loop runs
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()
	waitForShot(t, "the DXGI loop to poll", func() bool { return cap.textures.Load() > 0 })

	out := captureAsync(m)
	waitForShot(t, "the DXGI loop to attempt the request", func() bool { return cap.captures.Load() > 0 })
	cap.tight.Store(false) // the DXGI loop returns captureModeTicker next iteration
	cap.nilFrames.Store(0)

	if o := awaitOutcome(t, out); o.err != nil || o.img == nil {
		t.Fatalf("outcome = (%v, %v), want a frame served after the mode switch", o.img, o.err)
	}
	stop()
	assertServedOnLoop(t, cap)
}

// Two concurrent callers (take_screenshot and computer_action) are each
// answered, in order.
func TestCaptureScreenshot_ConcurrentRequestsBothServed(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(true, true)
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()
	waitForShot(t, "the stream to encode frames", func() bool { return cap.textures.Load() > 2 })

	a, b := captureAsync(m), captureAsync(m)
	for i, out := range []<-chan shotOutcome{a, b} {
		if o := awaitOutcome(t, out); o.err != nil || o.img == nil {
			t.Fatalf("caller %d: (%v, %v), want a frame", i, o.img, o.err)
		}
	}
	stop()
	assertServedOnLoop(t, cap)
}

// A session that never produces a frame fails the request after the attempt
// budget instead of hanging until the timeout.
func TestCaptureScreenshot_NoFrameFailsAfterAttempts(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(false, false)
	cap.nilFrames.Store(1 << 30)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	stop, _ := runLoop(t, s)
	defer stop()
	waitForShot(t, "the ticker loop to capture", func() bool { return cap.captures.Load() > 0 })

	_, _, _, err := m.CaptureScreenshot(0)
	if !errors.Is(err, errScreenshotNoFrame) {
		t.Fatalf("err = %v, want errScreenshotNoFrame", err)
	}
	if errors.Is(err, ErrNoActiveSession) {
		t.Fatalf("err %v must not read as 'no session' (the tools layer would open a standalone capturer)", err)
	}
}

// Before the capture loop starts (the peer is still connecting) the caller
// captures directly, and the loop cannot start until that capture is done.
// After the loop has exited the request fails at once without touching the
// capturer.
func TestCaptureScreenshot_BeforeLoopStartsCapturesDirectly(t *testing.T) {
	cap := newHeldFrameCapturer(false, false)
	cap.gate, cap.entered = make(chan struct{}), make(chan struct{}, 1)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})

	out := captureAsync(m)
	<-cap.entered // the direct capture is in progress, queue locked
	stop, _ := runLoop(t, s)
	defer stop()
	time.Sleep(50 * time.Millisecond)
	if n := cap.captures.Load(); n != 1 {
		t.Fatalf("captures = %d while the direct capture was in progress, want 1 (the loop must wait)", n)
	}
	close(cap.gate) // let the direct capture and then the loop run
	if o := awaitOutcome(t, out); o.err != nil || o.img == nil {
		t.Fatalf("direct capture before loop start = (%v, %v), want a frame", o.img, o.err)
	}
	waitForShot(t, "the loop to start capturing", func() bool { return cap.captures.Load() > 1 })

	stop()
	before := cap.captures.Load()
	_, _, _, err := m.CaptureScreenshot(0)
	if !errors.Is(err, errScreenshotSessionStopped) || errors.Is(err, ErrNoActiveSession) {
		t.Fatalf("after the loop exits: err = %v, want errScreenshotSessionStopped", err)
	}
	if after := cap.captures.Load(); after != before {
		t.Fatalf("Capture() called %d times with the loop gone, want none", after-before)
	}
}

// A capture loop that dies (here a panic inside the screenshot's capture)
// without done being closed still answers the pending request at once.
func TestCaptureScreenshot_LoopCrashAnswersPendingRequest(t *testing.T) {
	longScreenshotTimeout(t)
	cap := newHeldFrameCapturer(false, false)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	stop, exited := runLoop(t, s)
	defer stop()
	waitForShot(t, "the ticker loop to capture", func() bool { return cap.captures.Load() > 0 })

	cap.panicNow.Store(true)
	start := time.Now()
	o := awaitOutcome(t, captureAsync(m))
	if !errors.Is(o.err, errScreenshotSessionStopped) {
		t.Fatalf("err = %v, want errScreenshotSessionStopped", o.err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("answer took %v, want well under the request timeout", took)
	}
	<-exited
}

// pendingSession is a session whose loop has "started" but does not run, so
// requests stay queued until the test acts.
func pendingSession(t *testing.T) (*SessionManager, *Session, *heldFrameCapturer) {
	t.Helper()
	cap := newHeldFrameCapturer(false, false)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	s.screenshots.markLoopStarted()
	return m, s, cap
}

func pendingCount(s *Session) int {
	s.screenshots.mu.Lock()
	defer s.screenshots.mu.Unlock()
	return len(s.screenshots.pending)
}

type shotOutcome struct {
	img *image.RGBA
	err error
}

func captureAsync(m *SessionManager) <-chan shotOutcome {
	out := make(chan shotOutcome, 1)
	go func() {
		img, _, _, err := m.CaptureScreenshot(0)
		out <- shotOutcome{img, err}
	}()
	return out
}

func awaitOutcome(t *testing.T, out <-chan shotOutcome) shotOutcome {
	t.Helper()
	select {
	case o := <-out:
		return o
	case <-time.After(15 * time.Second):
		t.Fatal("CaptureScreenshot did not return")
		return shotOutcome{}
	}
}

// Timeout: the loop never answers. The caller gets a bounded error that is
// not ErrNoActiveSession, and the loop later drops the expired request
// without capturing for it.
func TestCaptureScreenshot_TimeoutIsBoundedAndDropped(t *testing.T) {
	prev := screenshotRequestTimeout
	screenshotRequestTimeout = 50 * time.Millisecond
	defer func() { screenshotRequestTimeout = prev }()

	m, s, cap := pendingSession(t)
	start := time.Now()
	_, _, _, err := m.CaptureScreenshot(0)
	if !errors.Is(err, errScreenshotTimeout) || errors.Is(err, ErrNoActiveSession) {
		t.Fatalf("err = %v, want errScreenshotTimeout", err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("timeout took %v", took)
	}

	if s.serveScreenshotRequest() {
		t.Fatalf("the loop served a request whose caller had given up")
	}
	if cap.captures.Load() != 0 || pendingCount(s) != 0 {
		t.Fatalf("captures=%d pending=%d, want the expired request dropped untouched",
			cap.captures.Load(), pendingCount(s))
	}
}

// Session stopped while a request is pending: the caller returns at once on
// done, and the loop's exit answers anything still queued (no leak, no send
// on a closed channel: reply channels are buffered and never closed).
func TestCaptureScreenshot_SessionStopsWhilePending(t *testing.T) {
	t.Run("done closes", func(t *testing.T) {
		longScreenshotTimeout(t)
		m, s, _ := pendingSession(t)
		out := captureAsync(m)
		waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
		close(s.done)
		if o := awaitOutcome(t, out); !errors.Is(o.err, errScreenshotSessionStopped) {
			t.Fatalf("err = %v, want errScreenshotSessionStopped", o.err)
		}
		s.screenshots.markLoopExited() // loop exit after the caller left
		if pendingCount(s) != 0 {
			t.Fatalf("pending = %d after loop exit, want 0", pendingCount(s))
		}
	})
	t.Run("loop exits first", func(t *testing.T) {
		longScreenshotTimeout(t)
		m, s, _ := pendingSession(t)
		out := captureAsync(m)
		waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
		s.screenshots.markLoopExited()
		if o := awaitOutcome(t, out); !errors.Is(o.err, errScreenshotSessionStopped) {
			t.Fatalf("err = %v, want errScreenshotSessionStopped", o.err)
		}
	})
}

// Mid monitor switch: the request is served from the capturer the session
// has when the loop takes it, with that capturer's bounds and display.
func TestServeScreenshotRequest_UsesCurrentCapturerAfterSwitch(t *testing.T) {
	longScreenshotTimeout(t)
	m, s, oldCap := pendingSession(t)
	out := captureAsync(m)
	waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })

	newCap := &staticTestCapturer{img: image.NewRGBA(image.Rect(0, 0, 6, 2))}
	s.mu.Lock()
	s.capturer = newCap
	s.displayIndex = 1
	s.mu.Unlock()

	if !s.serveScreenshotRequest() {
		t.Fatal("serveScreenshotRequest did not take the pending request")
	}
	o := awaitOutcome(t, out)
	if o.err != nil || o.img == nil || o.img.Bounds().Dx() != 6 {
		t.Fatalf("outcome = (%v, %v), want the new capturer's 6x2 frame", o.img, o.err)
	}
	if oldCap.captures.Load() != 0 {
		t.Fatalf("the replaced capturer was used")
	}
}

// A capturer error ends the request with that error (still an active-session
// failure, never ErrNoActiveSession).
func TestServeScreenshotRequest_CapturerErrorEndsRequest(t *testing.T) {
	longScreenshotTimeout(t)
	m, s, cap := pendingSession(t)
	cap.held.Store(true) // Capture() fails as the DXGI fake does with a held frame
	out := captureAsync(m)
	waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
	if !s.serveScreenshotRequest() {
		t.Fatal("serveScreenshotRequest did not take the pending request")
	}
	o := awaitOutcome(t, out)
	if o.err == nil || errors.Is(o.err, ErrNoActiveSession) {
		t.Fatalf("err = %v, want the capturer's error", o.err)
	}
	if pendingCount(s) != 0 {
		t.Fatalf("pending = %d, want 0", pendingCount(s))
	}
}

// lostConnCapturer reports its own lost display connection as
// ErrNoActiveSession, as the Linux X11 capturer does.
type lostConnCapturer struct{ staticTestCapturer }

func (c *lostConnCapturer) Capture() (*image.RGBA, error) { return nil, ErrNoActiveSession }

// The session is live, so a capturer's ErrNoActiveSession must not reach the
// tools layer as "no session" (it would open a standalone capturer).
func TestServeScreenshotRequest_CapturerNoSessionErrorIsFlattened(t *testing.T) {
	longScreenshotTimeout(t)
	cap := &lostConnCapturer{}
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	s.screenshots.markLoopStarted()
	out := captureAsync(m)
	waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
	s.serveScreenshotRequest()
	o := awaitOutcome(t, out)
	if o.err == nil || errors.Is(o.err, ErrNoActiveSession) {
		t.Fatalf("err = %v, want an active-session failure that does not match ErrNoActiveSession", o.err)
	}
}

// No-frame failures name the error the capturer swallowed, when it has one.
type swallowingCapturer struct{ staticTestCapturer }

func (c *swallowingCapturer) Capture() (*image.RGBA, error) { return nil, nil }
func (c *swallowingCapturer) LastCaptureError() error {
	return errors.New("GetDIBits failed on the secure desktop")
}

func TestNoFrameErrorNamesSwallowedCaptureError(t *testing.T) {
	err := noFrameError(&swallowingCapturer{}, 10)
	if !errors.Is(err, errScreenshotNoFrame) {
		t.Fatalf("err = %v, want errScreenshotNoFrame", err)
	}
	for _, want := range []string{"after 10 attempts", "GetDIBits failed"} {
		if !bytes.Contains([]byte(err.Error()), []byte(want)) {
			t.Fatalf("err = %q, want it to contain %q", err, want)
		}
	}
}
