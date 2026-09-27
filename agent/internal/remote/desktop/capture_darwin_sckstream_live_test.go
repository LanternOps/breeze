//go:build darwin && cgo

package desktop

import (
	"os"
	"testing"
	"time"
)

// TestSCKStreamLiveFrameRate exercises the real SCStream capturer (#5928). It
// is skipped unless BREEZE_SCK_LIVE_TEST=1 because it needs a logged-in
// desktop and the Screen Recording grant for the test binary's parent
// (e.g. Terminal). Run it on a lab Mac, drag a window during the run, and read
// the logged rates:
//
//	BREEZE_SCK_LIVE_TEST=1 go test -run TestSCKStreamLiveFrameRate -v ./internal/remote/desktop/
func TestSCKStreamLiveFrameRate(t *testing.T) {
	if os.Getenv("BREEZE_SCK_LIVE_TEST") != "1" {
		t.Skip("set BREEZE_SCK_LIVE_TEST=1 to run against the real ScreenCaptureKit stream")
	}
	if !hasSCScreenshotManager() {
		t.Skip("ScreenCaptureKit capturer requires macOS 14+")
	}

	capturer, err := newSCKCapturer(CaptureConfig{DisplayIndex: 0, DesktopContext: "user_session"})
	if err != nil {
		t.Fatalf("newSCKCapturer: %v", err)
	}
	defer capturer.Close()

	first, err := capturer.Capture()
	if err != nil || first == nil {
		t.Fatalf("first Capture = (%v, %v)", first, err)
	}
	t.Logf("frame size %dx%d", first.Rect.Dx(), first.Rect.Dy())
	captureImagePool.Put(first)

	const window = 10 * time.Second
	ticker := time.NewTicker(time.Second / maxFrameRate)
	defer ticker.Stop()
	var frames, skips int
	var copyTotal, copyMax time.Duration
	deadline := time.Now().Add(window)
	for time.Now().Before(deadline) {
		<-ticker.C
		t0 := time.Now()
		img, err := capturer.Capture()
		d := time.Since(t0)
		if err != nil {
			t.Fatalf("Capture: %v", err)
		}
		if img == nil {
			skips++
			continue
		}
		frames++
		copyTotal += d
		if d > copyMax {
			copyMax = d
		}
		captureImagePool.Put(img)
	}
	avgCopy := time.Duration(0)
	if frames > 0 {
		avgCopy = copyTotal / time.Duration(frames)
	}
	t.Logf("over %v: %d frames (%.1f/s), %d unchanged ticks, copy avg %v max %v",
		window, frames, float64(frames)/window.Seconds(), skips, avgCopy, copyMax)
}
