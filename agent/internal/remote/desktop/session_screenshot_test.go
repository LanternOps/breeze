package desktop

import (
	"image"
	"testing"
)

// latestOnlyCapturer models the macOS SCStream capturer while the session loop
// is running: Capture() reports an unchanged screen as (nil, nil) because the
// loop already consumed the frame, but CaptureLatest() still has it (#5928).
type latestOnlyCapturer struct {
	staticTestCapturer
	captureCalls, latestCalls int
}

func (c *latestOnlyCapturer) Capture() (*image.RGBA, error) {
	c.captureCalls++
	return nil, nil
}

func (c *latestOnlyCapturer) CaptureLatest() (*image.RGBA, error) {
	c.latestCalls++
	return image.NewRGBA(image.Rect(0, 0, 8, 4)), nil
}

func TestCaptureFrameForScreenshot_UsesLatestFrameProvider(t *testing.T) {
	cap := &latestOnlyCapturer{}
	img, err := captureFrameForScreenshot(cap)
	if err != nil || img == nil {
		t.Fatalf("captureFrameForScreenshot = (%v, %v), want the latest frame", img, err)
	}
	if cap.latestCalls != 1 || cap.captureCalls != 0 {
		t.Fatalf("latest=%d capture=%d, want one CaptureLatest and no Capture (Capture would consume the stream loop's frame)",
			cap.latestCalls, cap.captureCalls)
	}
}

type nilThenFrameCapturer struct {
	staticTestCapturer
	calls int
}

func (c *nilThenFrameCapturer) Capture() (*image.RGBA, error) {
	c.calls++
	if c.calls < 3 {
		return nil, nil
	}
	return image.NewRGBA(image.Rect(0, 0, 2, 2)), nil
}

func TestCaptureFrameForScreenshot_RetriesNilFramesForOtherCapturers(t *testing.T) {
	cap := &nilThenFrameCapturer{}
	img, err := captureFrameForScreenshot(cap)
	if err != nil || img == nil {
		t.Fatalf("captureFrameForScreenshot = (%v, %v)", img, err)
	}
	if cap.calls != 3 {
		t.Fatalf("calls = %d, want retries until a frame arrives", cap.calls)
	}
}
