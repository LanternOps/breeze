package desktop

import (
	"image"
	"testing"
	"time"
)

// staticTestCapturer is a minimal ScreenCapturer that returns a fixed frame. It
// deliberately implements ONLY ScreenCapturer — not TightLoopHint,
// DesktopSwitchNotifier, or BGRAProvider — so captureAndSendFrame takes the
// non-DXGI, non-secure, RGBA path straight into the frame differ.
type staticTestCapturer struct{ img *image.RGBA }

func (c *staticTestCapturer) Capture() (*image.RGBA, error) { return c.img, nil }
func (c *staticTestCapturer) CaptureRegion(x, y, w, h int) (*image.RGBA, error) {
	return c.img, nil
}
func (c *staticTestCapturer) GetScreenBounds() (int, int, error) {
	return c.img.Rect.Dx(), c.img.Rect.Dy(), nil
}
func (c *staticTestCapturer) Close() error { return nil }

// TestCaptureLoopStaticScreenBumpsVideoWriteHeartbeat verifies the static-screen
// watchdog fix (Task 11 change #6): when the frame differ reports an unchanged
// frame on a non-secure desktop, captureAndSendFrame bumps lastVideoWriteUnixNano
// via the idle-resend path so the no-video watchdog does not terminate a healthy
// static (e.g. Linux/X11) session. It drives the real capture method end-to-end
// through the differ-skip branch rather than re-implementing it.
func TestCaptureLoopStaticScreenBumpsVideoWriteHeartbeat(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for i := range img.Pix {
		img.Pix[i] = 0x40
	}

	s := &Session{id: "test", isActive: true}
	s.capturer = &staticTestCapturer{img: img}
	// nil backend: IsGPUOnly() is false and Encode() is never reached on the
	// differ-skip path, so no real encoder is required.
	s.encoder.Store(&VideoEncoder{})
	s.metrics = newStreamMetrics()
	s.differ = newFrameDiffer()
	// Match desiredPF so SetPixelFormat is never called on the nil backend.
	s.encoderPF = PixelFormatRGBA

	// Prime the differ with the frame's bytes so the next identical capture is
	// reported as UNCHANGED, entering the differ-skip branch.
	if !s.differ.HasChanged(img.Pix) {
		t.Fatal("precondition: first frame should be reported as changed")
	}

	// Stale last-write so the idle-resend threshold is exceeded and the bump fires.
	stale := time.Now().Add(-time.Second)
	s.lastVideoWriteUnixNano.Store(stale.UnixNano())

	s.captureAndSendFrame(16 * time.Millisecond)

	if got := s.lastVideoWriteUnixNano.Load(); got <= stale.UnixNano() {
		t.Fatalf("static-screen differ-skip did not bump lastVideoWriteUnixNano (still %d, want > %d)", got, stale.UnixNano())
	}
	if skipped := s.metrics.FramesSkipped.Load(); skipped != 1 {
		t.Fatalf("expected exactly one skipped frame via the differ-skip branch, got %d", skipped)
	}
}

func TestSampleDuration(t *testing.T) {
	const fallback = 16 * time.Millisecond

	tests := []struct {
		name string
		// lastAgo < 0 means "never written" (lastSampleNanos = 0)
		lastAgo time.Duration
		// exact expected value, or 0 to use the range check below
		wantExact time.Duration
		wantMin   time.Duration
		wantMax   time.Duration
	}{
		{name: "first frame falls back", lastAgo: -1, wantExact: fallback},
		{name: "sub-millisecond delta falls back", lastAgo: 0, wantExact: fallback},
		{name: "normal gap returns real elapsed", lastAgo: 100 * time.Millisecond, wantMin: 100 * time.Millisecond, wantMax: time.Second},
		{name: "idle gap returns real elapsed", lastAgo: 2 * time.Second, wantMin: 2 * time.Second, wantMax: 3 * time.Second},
		{name: "pathological gap capped", lastAgo: 30 * time.Second, wantExact: maxSampleDuration},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Session{id: "test"}
			if tt.lastAgo >= 0 {
				s.lastSampleNanos.Store(time.Now().Add(-tt.lastAgo).UnixNano())
			}
			got := s.sampleDuration(fallback)
			if tt.wantExact != 0 {
				if got != tt.wantExact {
					t.Fatalf("sampleDuration = %v, want %v", got, tt.wantExact)
				}
				return
			}
			if got < tt.wantMin || got > tt.wantMax {
				t.Fatalf("sampleDuration = %v, want within [%v, %v]", got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestNoteSampleWrite_AdvancesSampleClock(t *testing.T) {
	s := &Session{id: "test"}
	if s.lastSampleNanos.Load() != 0 {
		t.Fatal("expected zero-value sample clock")
	}
	before := time.Now().UnixNano()
	s.noteSampleWrite()
	got := s.lastSampleNanos.Load()
	if got < before {
		t.Fatalf("noteSampleWrite did not advance lastSampleNanos: %d < %d", got, before)
	}
}

// TestMaybeResendCachedFrameOnIdle_DoesNotAdvanceSampleClock pins the
// capture-alive vs sample-written separation: the idle heartbeat bumps
// lastVideoWriteUnixNano (to keep the no-video watchdog quiet) but must NOT
// touch lastSampleNanos — if it did, the idle gap would be absorbed into the
// heartbeat and the next real frame's sampleDuration would no longer reflect
// the true inter-sample gap, re-introducing the media-clock drift this
// separation was added to fix.
func TestMaybeResendCachedFrameOnIdle_DoesNotAdvanceSampleClock(t *testing.T) {
	s := &Session{id: "test"}
	s.noteSampleWrite()
	sampleClockBefore := s.lastSampleNanos.Load()

	// Make the session look idle past the resend interval so the heartbeat
	// branch actually runs (rather than returning early).
	idleSince := time.Now().Add(-2 * staticDesktopResendInterval)
	s.lastVideoWriteUnixNano.Store(idleSince.UnixNano())

	s.maybeResendCachedFrameOnIdle(16 * time.Millisecond)

	if got := s.lastSampleNanos.Load(); got != sampleClockBefore {
		t.Fatalf("idle heartbeat advanced lastSampleNanos (%d -> %d); it must only touch lastVideoWriteUnixNano", sampleClockBefore, got)
	}
	if got := s.lastVideoWriteUnixNano.Load(); got <= idleSince.UnixNano() {
		t.Fatalf("idle heartbeat did not bump lastVideoWriteUnixNano (still %d)", got)
	}
}
