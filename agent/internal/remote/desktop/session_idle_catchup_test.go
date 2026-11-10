package desktop

import (
	"bytes"
	"image"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// holdingStubBackend is an encoder backend that keeps `hold` input frames
// before emitting, like Microsoft's software H264 MFT without effective
// low-latency mode (#11622). Its output for a frame is the frame's first
// byte, so a test can tell which captured frame the viewer received. It
// implements optionalIdleCatchUp with the same idleCatchUp bookkeeping the
// MFT uses.
type holdingStubBackend struct {
	stubEncoder
	hold    int
	queue   [][]byte
	last    []byte
	cu      idleCatchUp
	encodes int
}

func (b *holdingStubBackend) submit(frame []byte, refeed bool) []byte {
	b.encodes++
	b.queue = append(b.queue, []byte{frame[0]})
	b.cu.noteSubmitted(refeed)
	if len(b.queue) <= b.hold {
		return nil
	}
	out := b.queue[0]
	b.queue = b.queue[1:]
	b.cu.noteEmitted()
	return out
}

func (b *holdingStubBackend) Encode(frame []byte) ([]byte, error) {
	b.last = append(b.last[:0], frame...)
	return b.submit(frame, false), nil
}

func (b *holdingStubBackend) CatchUpIdle() ([]byte, error) {
	if len(b.last) == 0 || !b.cu.startRefeed() {
		return nil, nil
	}
	return b.submit(b.last, true), nil
}

// scriptedIdleCapturer returns `frames` distinct BGRA frames (pixel value 1,
// 2, ...) and then reports "no new frame" (nil, nil), as DXGI does when the
// screen has not changed.
type scriptedIdleCapturer struct {
	frames int
	n      int
}

func (c *scriptedIdleCapturer) Capture() (*image.RGBA, error) {
	if c.n >= c.frames {
		return nil, nil
	}
	c.n++
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for i := range img.Pix {
		img.Pix[i] = byte(c.n)
	}
	return img, nil
}
func (c *scriptedIdleCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return c.Capture()
}
func (c *scriptedIdleCapturer) GetScreenBounds() (int, int, error) { return 4, 4, nil }
func (c *scriptedIdleCapturer) Close() error                       { return nil }
func (c *scriptedIdleCapturer) IsBGRA() bool                       { return true }

func newIdleCatchUpSession(t *testing.T, frames int, backend encoderBackend) *Session {
	t.Helper()
	s := &Session{id: "idle-catchup", isActive: true}
	s.capturer = &scriptedIdleCapturer{frames: frames}
	s.encoder.Store(&VideoEncoder{backend: backend})
	s.metrics = newStreamMetrics()
	s.differ = newFrameDiffer()
	s.encoderPF = PixelFormatBGRA
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "test")
	if err != nil {
		t.Fatal(err)
	}
	s.videoTrack = track
	return s
}

func lastSentFrame(s *Session) []byte {
	s.lastEncodedMu.RLock()
	defer s.lastEncodedMu.RUnlock()
	return append([]byte(nil), s.lastEncodedFrame...)
}

// #11622: with an encoder that holds frames, the newest screen change must
// reach the viewer while the screen is static, not when five more changes
// arrive.
func TestCaptureAndSendFrame_IdleCatchUpDeliversNewestFrame(t *testing.T) {
	backend := &holdingStubBackend{hold: 5}
	s := newIdleCatchUpSession(t, 10, backend)

	for i := 0; i < 10; i++ {
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	if got := lastSentFrame(s); bytes.Equal(got, []byte{10}) {
		t.Fatalf("precondition: the holding encoder must not have emitted frame 10 yet")
	}

	for i := 0; i < 30; i++ { // static screen
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	if got := lastSentFrame(s); !bytes.Equal(got, []byte{10}) {
		t.Fatalf("after a static period the viewer's newest frame is %v, want frame [10]", got)
	}
	if backend.encodes != 15 {
		t.Fatalf("encodes = %d, want 10 captured + 5 re-submits (bounded, then a static screen costs nothing)", backend.encodes)
	}
	if skipped := s.metrics.FramesSkipped.Load(); skipped != 30 {
		t.Fatalf("idle iterations still count as skipped captures: got %d, want 30", skipped)
	}
}

// An encoder that implements the catch-up but does not hold frames (the
// software MFT with low-latency mode working) is never re-fed at idle, and an
// encoder without the catch-up (OpenH264, NVENC, AMF) is never asked.
func TestCaptureAndSendFrame_IdleNoCatchUpForNonHoldingEncoder(t *testing.T) {
	backend := &holdingStubBackend{hold: 0}
	s := newIdleCatchUpSession(t, 3, backend)
	for i := 0; i < 20; i++ {
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	if backend.encodes != 3 {
		t.Fatalf("encodes = %d, want only the 3 captured frames", backend.encodes)
	}
	if got := lastSentFrame(s); !bytes.Equal(got, []byte{3}) {
		t.Fatalf("viewer's newest frame is %v, want [3]", got)
	}

	stub := newWarmupStub(encodeOK)
	s = newIdleCatchUpSession(t, 3, stub)
	for i := 0; i < 20; i++ {
		s.captureAndSendFrame(16 * time.Millisecond)
	}
	if calls := stub.calls.Load(); calls != 3 {
		t.Fatalf("Encode calls = %d, want only the 3 captured frames", calls)
	}
}
