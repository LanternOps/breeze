package desktop

import (
	"errors"
	"image"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// resizingCapturer is a fake capturer whose display mode can change between
// frames, like a resolution change mid-session. Every frame is distinct (so
// the differ never skips it) and BGRA (so cursor compositing is skipped).
type resizingCapturer struct {
	mu   sync.Mutex
	w, h int
	n    byte
}

func (c *resizingCapturer) setSize(w, h int) {
	c.mu.Lock()
	c.w, c.h = w, h
	c.mu.Unlock()
}

func (c *resizingCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	img := image.NewRGBA(image.Rect(0, 0, c.w, c.h))
	for i := range img.Pix {
		img.Pix[i] = c.n
	}
	return img, nil
}
func (c *resizingCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return c.Capture()
}
func (c *resizingCapturer) GetScreenBounds() (int, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.w, c.h, nil
}
func (c *resizingCapturer) Close() error { return nil }
func (c *resizingCapturer) IsBGRA() bool { return true }

// sizedStubEncoder behaves like the real backends on the CPU path: it encodes
// only frames of exactly its configured size (FitRGBAFrame) and errors on any
// other, so a resolution change the session does not follow fails every frame.
type sizedStubEncoder struct {
	stubEncoder
	mu        sync.Mutex
	name      string
	w, h      int
	setDims   [][2]int
	keyframes int
	encodes   int
	dimErr    error
}

func (e *sizedStubEncoder) Encode(frame []byte) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := FitRGBAFrame(frame, e.w, e.h); err != nil {
		return nil, err
	}
	e.encodes++
	return []byte{0, 0, 0, 1, 0x65}, nil
}
func (e *sizedStubEncoder) SetDimensions(w, h int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.setDims = append(e.setDims, [2]int{w, h})
	if e.dimErr != nil {
		return e.dimErr
	}
	e.w, e.h = AlignEven(w, h)
	return nil
}
func (e *sizedStubEncoder) ForceKeyframe() error {
	e.mu.Lock()
	e.keyframes++
	e.mu.Unlock()
	return nil
}
func (e *sizedStubEncoder) Name() string { return e.name }
func (e *sizedStubEncoder) snapshot() (w, h, keyframes, encodes int, setDims [][2]int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.w, e.h, e.keyframes, e.encodes, append([][2]int(nil), e.setDims...)
}

// newGeometryTestSession builds a session streaming from a resizingCapturer at
// w x h through a sizedStubEncoder already configured for that size, the way
// StartSession leaves it.
func newGeometryTestSession(t *testing.T, w, h int, backendName string) (*Session, *resizingCapturer, *sizedStubEncoder, *SafeInput) {
	t.Helper()
	si := NewSafeInput(&workerRecorder{}, "geom")
	t.Cleanup(si.Close)
	cap := &resizingCapturer{w: w, h: h}
	stub := &sizedStubEncoder{name: backendName}
	enc := &VideoEncoder{backend: stub}
	if err := enc.SetDimensions(w, h); err != nil {
		t.Fatal(err)
	}
	s := &Session{id: "geom", isActive: true, inputHandler: si}
	s.capturer = cap
	s.encoder.Store(enc)
	s.metrics = newStreamMetrics()
	s.differ = newFrameDiffer()
	s.encoderPF = PixelFormatBGRA
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "geom")
	if err != nil {
		t.Fatal(err)
	}
	s.videoTrack = track
	return s, cap, stub, si
}

// #11754: a display mode change mid-session resizes the encoder in place and
// sends the first frame at the new size, instead of failing every frame.
func TestCaptureAndSendFrameFollowsResolutionChange(t *testing.T) {
	for _, backend := range []string{"mft", "openh264"} {
		t.Run(backend, func(t *testing.T) {
			s, cap, stub, si := newGeometryTestSession(t, 1920, 1080, backend)
			enc := s.encoder.Load()

			s.captureAndSendFrame(16 * time.Millisecond)
			if _, _, _, encodes, _ := stub.snapshot(); encodes != 1 {
				t.Fatalf("precondition: first frame at the start size was not encoded (encodes=%d)", encodes)
			}
			_, geoBefore := si.Epochs()
			_, _, kfBefore, _, _ := stub.snapshot()

			cap.setSize(2560, 1440)
			s.captureAndSendFrame(16 * time.Millisecond)

			w, h, kf, encodes, _ := stub.snapshot()
			if w != 2560 || h != 1440 {
				t.Fatalf("encoder dimensions after the change = %dx%d, want 2560x1440", w, h)
			}
			if encodes != 2 {
				t.Fatalf("the first frame at the new size was not encoded (encodes=%d, cpuEncodeErrors=%d)", encodes, s.cpuEncodeErrors)
			}
			if kf <= kfBefore {
				t.Fatalf("no keyframe forced at the new size (keyframes %d -> %d)", kfBefore, kf)
			}
			if s.cpuEncodeErrors != 0 {
				t.Fatalf("cpuEncodeErrors = %d, want 0", s.cpuEncodeErrors)
			}
			if s.encoder.Load() != enc {
				t.Fatalf("the encoder was replaced; a resolution change must resize it in place")
			}
			if _, geo := si.Epochs(); geo <= geoBefore {
				t.Fatalf("geometry epoch did not move (%d -> %d): input mapped to the old size would still be accepted", geoBefore, geo)
			}
		})
	}
}

// A steady stream at one size is not a geometry transition.
func TestCaptureAndSendFrameSteadySizeIsNotATransition(t *testing.T) {
	s, _, stub, si := newGeometryTestSession(t, 1920, 1080, "mft")
	_, geoBefore := si.Epochs()
	for i := 0; i < 5; i++ {
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	_, _, _, encodes, setDims := stub.snapshot()
	if encodes != 5 {
		t.Fatalf("encodes = %d, want 5", encodes)
	}
	if len(setDims) != 1 {
		t.Fatalf("SetDimensions called %d times on a steady stream, want only the initial call: %v", len(setDims), setDims)
	}
	if _, geo := si.Epochs(); geo != geoBefore {
		t.Fatalf("geometry epoch moved on a steady stream (%d -> %d)", geoBefore, geo)
	}
}

// refreshRecorder is a workerRecorder whose platform handler caches screen
// metrics, like the Windows and macOS handlers.
type refreshRecorder struct {
	workerRecorder
}

func (h *refreshRecorder) RefreshScreenGeometry() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, "refresh_geometry")
}

// recordAnnouncements captures the geometry announcements the viewer would be
// sent, for the duration of the test.
func recordAnnouncements(t *testing.T) func() []map[string]any {
	t.Helper()
	var mu sync.Mutex
	var got []map[string]any
	prev := sendGeometryAnnouncement
	sendGeometryAnnouncement = func(_ *Session, body map[string]any) {
		mu.Lock()
		got = append(got, body)
		mu.Unlock()
	}
	t.Cleanup(func() { sendGeometryAnnouncement = prev })
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), got...)
	}
}

func hasCall(calls []string, want string) bool {
	for _, c := range calls {
		if c == want {
			return true
		}
	}
	return false
}

// The viewer is told the new size and the epochs to use with it, held input
// is released, and the input handler re-reads its screen metrics.
func TestResolutionChangeAnnouncesGeometryAndRefreshesInput(t *testing.T) {
	announced := recordAnnouncements(t)
	inner := &refreshRecorder{}
	si := NewSafeInput(inner, "geom")
	t.Cleanup(si.Close)
	s, cap, _, _ := newGeometryTestSession(t, 1920, 1080, "mft")
	s.inputHandler = si
	s.displayIndex = 1

	s.captureAndSendFrame(16 * time.Millisecond)
	if n := len(announced()); n != 0 {
		t.Fatalf("a frame at the start size announced %d geometry changes", n)
	}
	if err := si.HandleEvent(InputEvent{Type: "key_down", Key: "shift"}); err != nil {
		t.Fatal(err)
	}

	cap.setSize(1280, 720)
	s.captureAndSendFrame(16 * time.Millisecond)

	got := announced()
	if len(got) != 1 {
		t.Fatalf("announcements = %d, want 1: %v", len(got), got)
	}
	msg := got[0]
	epoch, geo := si.Epochs()
	want := map[string]any{
		"type": "monitor_switched", "index": 1, "width": 1280, "height": 720,
		"reason": "resolution_change", "inputEpoch": epoch, "geoEpoch": geo,
	}
	for k, v := range want {
		if msg[k] != v {
			t.Errorf("monitor_switched[%q] = %v (%T), want %v (%T)", k, msg[k], msg[k], v, v)
		}
	}
	calls := inner.snapshot()
	if !hasCall(calls, "key_up:shift") {
		t.Errorf("held input was not released on the resolution change: %v", calls)
	}
	if !hasCall(calls, "refresh_geometry") {
		t.Errorf("the input handler did not re-read its screen metrics: %v", calls)
	}
}

// Odd capture sizes (fractional DPI) are aligned like the encoder aligns them,
// so they neither look like a change every frame nor resize the encoder.
func TestOddCaptureSizeIsNotAResolutionChange(t *testing.T) {
	announced := recordAnnouncements(t)
	s, cap, stub, _ := newGeometryTestSession(t, 1512, 948, "mft")
	cap.setSize(1512, 949) // one extra row: what an unaligned capturer yields
	for i := 0; i < 3; i++ {
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	if n := len(announced()); n != 0 {
		t.Fatalf("an odd extra row was announced as a geometry change %d times", n)
	}
	_, _, _, encodes, setDims := stub.snapshot()
	if encodes != 3 || len(setDims) != 1 {
		t.Fatalf("encodes=%d setDims=%v, want 3 encodes and only the initial SetDimensions", encodes, setDims)
	}
}

// When the encoder cannot be resized, frames of the new size are dropped (not
// fed to it to fail), and the resize is retried only after a backoff.
func TestResolutionChangeEncoderResizeFailureBacksOff(t *testing.T) {
	recordAnnouncements(t)
	s, cap, stub, _ := newGeometryTestSession(t, 1920, 1080, "openh264")
	stub.mu.Lock()
	stub.dimErr = errFakeResize
	stub.mu.Unlock()

	cap.setSize(2560, 1440)
	s.captureAndSendFrame(16 * time.Millisecond)
	s.captureAndSendFrame(16 * time.Millisecond)

	_, _, _, encodes, setDims := stub.snapshot()
	if encodes != 0 {
		t.Fatalf("a frame of the new size reached the unresized encoder (%d encodes)", encodes)
	}
	if s.cpuEncodeErrors != 0 {
		t.Fatalf("cpuEncodeErrors = %d: the mismatch must not be fed to Encode", s.cpuEncodeErrors)
	}
	// The initial StartSession-style call plus exactly one resize attempt.
	if len(setDims) != 2 {
		t.Fatalf("SetDimensions calls = %v, want the initial one plus one attempt inside the backoff", setDims)
	}

	// After the backoff the resize is tried again and, once it works, the
	// stream resumes at the new size.
	stub.mu.Lock()
	stub.dimErr = nil
	stub.mu.Unlock()
	s.encoderResizeRetryAt = time.Now().Add(-time.Millisecond)
	s.captureAndSendFrame(16 * time.Millisecond)
	if w, h, _, encodes, _ := stub.snapshot(); w != 2560 || h != 1440 || encodes != 1 {
		t.Fatalf("after the backoff: encoder %dx%d, encodes %d; want 2560x1440 and 1", w, h, encodes)
	}
}

// The GPU texture path has no CPU frame; it follows the capturer's bounds.
func TestFollowBoundsGeometryResizesForTexturePath(t *testing.T) {
	announced := recordAnnouncements(t)
	s, cap, stub, si := newGeometryTestSession(t, 1920, 1080, "mft")
	s.captureW, s.captureH = 1920, 1080
	enc := s.encoder.Load()
	_, geoBefore := si.Epochs()

	if !s.followBoundsGeometry(cap, enc) {
		t.Fatalf("unchanged bounds must not block the texture path")
	}
	if len(announced()) != 0 {
		t.Fatalf("unchanged bounds announced a geometry change")
	}

	cap.setSize(3840, 2160)
	if !s.followBoundsGeometry(cap, enc) {
		t.Fatalf("a resizable encoder must not block the texture path")
	}
	if w, h, kf, _, _ := stub.snapshot(); w != 3840 || h != 2160 || kf == 0 {
		t.Fatalf("encoder after a mode change: %dx%d keyframes=%d; want 3840x2160 and a forced keyframe", w, h, kf)
	}
	if _, geo := si.Epochs(); geo <= geoBefore {
		t.Fatalf("geometry epoch did not move (%d -> %d)", geoBefore, geo)
	}
	if got := announced(); len(got) != 1 || got[0]["width"] != 3840 || got[0]["height"] != 2160 {
		t.Fatalf("announcements = %v, want one at 3840x2160", got)
	}
}

// A frame taken from a capturer that a monitor switch has since replaced is
// not announced: the switch announces the new monitor itself.
func TestResolutionChangeFromReplacedCapturerIsNotAnnounced(t *testing.T) {
	announced := recordAnnouncements(t)
	s, cap, _, si := newGeometryTestSession(t, 1920, 1080, "mft")
	s.captureW, s.captureH = 1920, 1080
	_, geoBefore := si.Epochs()
	s.mu.Lock()
	s.capturer = &resizingCapturer{w: 1280, h: 1024}
	s.mu.Unlock()

	s.applyCaptureGeometry(cap, 2560, 1440, geometryReasonResolutionChange)

	if n := len(announced()); n != 0 {
		t.Fatalf("a replaced capturer's frame was announced (%d)", n)
	}
	if _, geo := si.Epochs(); geo != geoBefore {
		t.Fatalf("geometry epoch moved for a replaced capturer (%d -> %d)", geoBefore, geo)
	}
}

func TestSafeInputRefreshScreenGeometryRunsOnTheWorker(t *testing.T) {
	inner := &refreshRecorder{}
	si := NewSafeInput(inner, "geom")
	t.Cleanup(si.Close)
	si.RefreshScreenGeometry()
	if !hasCall(inner.snapshot(), "refresh_geometry") {
		t.Fatalf("RefreshScreenGeometry was not forwarded: %v", inner.snapshot())
	}
	// A handler without cached metrics is left alone.
	plain := NewSafeInput(&workerRecorder{}, "plain")
	t.Cleanup(plain.Close)
	plain.RefreshScreenGeometry()
}

var errFakeResize = errors.New("fake: encoder cannot run at this size")
