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
// apart from the screenshot caller's.
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
// goroutine other than the one driving CaptureTexture (the capture loop).
type heldFrameCapturer struct {
	held       atomic.Bool
	loopGID    atomic.Int64
	textures   atomic.Int64
	captures   atomic.Int64
	offThread  atomic.Int64 // Capture() from a goroutine other than the loop
	whileHeld  atomic.Int64 // Capture() while a texture frame was held (teardown)
	nilFrames  atomic.Int64 // Capture() calls left to answer with "no new frame"
	tightLoop  bool
	gpuTexture bool
}

func (c *heldFrameCapturer) Capture() (*image.RGBA, error) {
	c.captures.Add(1)
	if gid := c.loopGID.Load(); gid != 0 && goroutineID() != gid {
		c.offThread.Add(1)
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
func (c *heldFrameCapturer) TightLoop() bool                    { return c.tightLoop }

func (c *heldFrameCapturer) CaptureTexture() (uintptr, error) {
	c.loopGID.CompareAndSwap(0, goroutineID())
	c.textures.Add(1)
	if !c.gpuTexture {
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

// runLoop starts the real capture loop and returns a func that stops it and
// waits for it to exit.
func runLoop(t *testing.T, s *Session) (stop func()) {
	t.Helper()
	exited := make(chan struct{})
	go func() {
		defer close(exited)
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
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Fatal("capture loop did not exit after done was closed")
		}
	}
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

// #12624: a one-shot screenshot during a live GPU-path session must not drive
// the capturer from the caller's goroutine. On main it called Capture() there,
// which lands while the stream holds its DXGI frame and tears the device down.
func TestCaptureScreenshot_GPUStreamServedByCaptureLoop(t *testing.T) {
	cap := &heldFrameCapturer{tightLoop: true, gpuTexture: true}
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop := runLoop(t, s)
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

	if n := cap.offThread.Load(); n != 0 {
		t.Errorf("Capture() ran %d times off the capture loop's goroutine; the loop must serve screenshots", n)
	}
	if n := cap.whileHeld.Load(); n != 0 {
		t.Errorf("Capture() ran %d times while the stream held a DXGI frame (would tear the device down)", n)
	}
}

// assertServedOnLoop checks that no capture ran off the loop's goroutine and
// none ran while the stream held a frame.
func assertServedOnLoop(t *testing.T, cap *heldFrameCapturer) {
	t.Helper()
	if n := cap.offThread.Load(); n != 0 {
		t.Errorf("Capture() ran %d times off the capture loop's goroutine", n)
	}
	if n := cap.whileHeld.Load(); n != 0 {
		t.Errorf("Capture() ran %d times while the stream held a frame", n)
	}
}

// Idle GPU stream: CaptureTexture reports no new frame and the first captures
// see none either (a static screen). The loop keeps trying, repainting, until
// a frame arrives.
func TestCaptureScreenshot_IdleStreamRetriesOnLoop(t *testing.T) {
	cap := &heldFrameCapturer{tightLoop: true, gpuTexture: false}
	cap.nilFrames.Store(3)
	m, s := newLoopTestSession(t, cap, &gpuStubEncoder{})
	stop := runLoop(t, s)
	defer stop()
	waitForShot(t, "the idle stream to poll", func() bool { return cap.textures.Load() > 2 })

	img, w, h, err := m.CaptureScreenshot(0)
	if err != nil || img == nil || w != 8 || h != 4 {
		t.Fatalf("CaptureScreenshot = (%v, %d, %d, %v), want an 8x4 frame", img, w, h, err)
	}
	if got := cap.captures.Load(); got != 4 {
		t.Errorf("captures = %d, want 4 (three empty attempts, then the frame)", got)
	}
	stop()
	assertServedOnLoop(t, cap)
}

// CPU capture path (no TextureProvider use, ticker loop — GDI fallback,
// secure desktop, Linux): the ticker loop serves the request too.
func TestCaptureScreenshot_TickerLoopServesRequest(t *testing.T) {
	cap := &heldFrameCapturer{tightLoop: false}
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	stop := runLoop(t, s)
	defer stop()
	waitForShot(t, "the ticker loop to capture", func() bool { return cap.captures.Load() > 1 })

	img, _, _, err := m.CaptureScreenshot(0)
	if err != nil || img == nil {
		t.Fatalf("CaptureScreenshot = (%v, %v), want a frame", img, err)
	}
	stop()
	assertServedOnLoop(t, cap)
}

// A session that never produces a frame fails the request after the attempt
// budget instead of hanging until the timeout.
func TestCaptureScreenshot_NoFrameFailsAfterAttempts(t *testing.T) {
	cap := &heldFrameCapturer{tightLoop: false}
	cap.nilFrames.Store(1 << 30)
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	stop := runLoop(t, s)
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

// Before the capture loop starts (session still connecting) or after it has
// exited, the request fails at once and the capturer is not touched from the
// caller's goroutine.
func TestCaptureScreenshot_LoopNotRunning(t *testing.T) {
	cap := &heldFrameCapturer{}
	m, s := newLoopTestSession(t, cap, &stubEncoder{})

	_, _, _, err := m.CaptureScreenshot(0)
	if !errors.Is(err, errScreenshotLoopNotRunning) || errors.Is(err, ErrNoActiveSession) {
		t.Fatalf("before the loop starts: err = %v, want errScreenshotLoopNotRunning", err)
	}

	stop := runLoop(t, s)
	waitForShot(t, "the loop to start", func() bool { return cap.captures.Load() > 0 })
	stop()
	before := cap.captures.Load()
	_, _, _, err = m.CaptureScreenshot(0)
	if !errors.Is(err, errScreenshotLoopNotRunning) {
		t.Fatalf("after the loop exits: err = %v, want errScreenshotLoopNotRunning", err)
	}
	if after := cap.captures.Load(); after != before {
		t.Fatalf("Capture() called %d times with no loop running, want none", after-before)
	}
}

// pendingSession is a session whose queue accepts requests but whose loop is
// not running, so requests stay pending until the test acts.
func pendingSession(t *testing.T) (*SessionManager, *Session, *heldFrameCapturer) {
	t.Helper()
	cap := &heldFrameCapturer{}
	m, s := newLoopTestSession(t, cap, &stubEncoder{})
	s.screenshots.setLoopRunning(true)
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
	case <-time.After(5 * time.Second):
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
// on a closed channel — reply channels are buffered and never closed).
func TestCaptureScreenshot_SessionStopsWhilePending(t *testing.T) {
	t.Run("done closes", func(t *testing.T) {
		m, s, _ := pendingSession(t)
		out := captureAsync(m)
		waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
		close(s.done)
		if o := awaitOutcome(t, out); !errors.Is(o.err, errScreenshotSessionStopped) {
			t.Fatalf("err = %v, want errScreenshotSessionStopped", o.err)
		}
		s.screenshots.setLoopRunning(false) // loop exit after the caller left
		if pendingCount(s) != 0 {
			t.Fatalf("pending = %d after loop exit, want 0", pendingCount(s))
		}
	})
	t.Run("loop exits first", func(t *testing.T) {
		m, s, _ := pendingSession(t)
		out := captureAsync(m)
		waitForShot(t, "the request to queue", func() bool { return pendingCount(s) == 1 })
		s.screenshots.setLoopRunning(false)
		if o := awaitOutcome(t, out); !errors.Is(o.err, errScreenshotSessionStopped) {
			t.Fatalf("err = %v, want errScreenshotSessionStopped", o.err)
		}
	})
}

// Mid monitor switch: the request is served from the capturer the session
// has when the loop takes it, with that capturer's bounds and display.
func TestServeScreenshotRequest_UsesCurrentCapturerAfterSwitch(t *testing.T) {
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
