package desktop

import (
	"image"
	"sync/atomic"
	"testing"
)

// latestOnlyCapturer models the macOS SCStream capturer while the session loop
// is running: Capture() reports an unchanged screen as (nil, nil) because the
// loop already consumed the frame, but CaptureLatest() still has it (#5928).
type latestOnlyCapturer struct {
	staticTestCapturer
	captureCalls, latestCalls atomic.Int64
}

func (c *latestOnlyCapturer) Capture() (*image.RGBA, error) {
	c.captureCalls.Add(1)
	return nil, nil
}

func (c *latestOnlyCapturer) CaptureLatest() (*image.RGBA, error) {
	c.latestCalls.Add(1)
	return image.NewRGBA(image.Rect(0, 0, 8, 4)), nil
}

func (c *latestOnlyCapturer) GetScreenBounds() (int, int, error) { return 8, 4, nil }

func TestCaptureLatestForScreenshot_ReturnsLatestFrame(t *testing.T) {
	cap := &latestOnlyCapturer{}
	img, err := captureLatestForScreenshot(cap)
	if err != nil || img == nil {
		t.Fatalf("captureLatestForScreenshot = (%v, %v), want the latest frame", img, err)
	}
	if cap.latestCalls.Load() != 1 || cap.captureCalls.Load() != 0 {
		t.Fatalf("latest=%d capture=%d, want one CaptureLatest and no Capture (Capture would consume the stream loop's frame)",
			cap.latestCalls.Load(), cap.captureCalls.Load())
	}
}

// The macOS branch is unchanged by #12624: a LatestFrameProvider session is
// read directly, without the capture loop (none runs in this test).
func TestCaptureScreenshot_LatestFrameProviderReadDirectly(t *testing.T) {
	cap := &latestOnlyCapturer{}
	s := &Session{id: "mac", isActive: true, done: make(chan struct{})}
	s.capturer = cap
	m := &SessionManager{sessions: map[string]*Session{s.id: s}}

	img, w, h, err := m.CaptureScreenshot(0)
	if err != nil || img == nil || w != 8 || h != 4 {
		t.Fatalf("CaptureScreenshot = (%v, %d, %d, %v), want the latest 8x4 frame", img, w, h, err)
	}
	if cap.captureCalls.Load() != 0 {
		t.Fatalf("Capture() called %d times, want none", cap.captureCalls.Load())
	}
}
