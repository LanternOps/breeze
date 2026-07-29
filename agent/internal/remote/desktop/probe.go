package desktop

import (
	"fmt"
	"image"
	"time"
)

// probeCapture validates that a capturer can actually produce a frame before
// a WebRTC answer is returned. The GDI fallback reports transient failures as
// (nil, nil) — "no frame yet" — which the streaming loop tolerates, but the
// startup probe must not: a session in a non-capturable Windows session (e.g.
// no input desktop) would otherwise start and stream black. Nil-frame results
// are retried with a short delay to ride out secure-desktop transitions; a
// hard error fails immediately.
func probeCapture(capture func() (*image.RGBA, error), attempts int, delay time.Duration) (*image.RGBA, error) {
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(delay)
		}
		img, err := capture()
		if err != nil {
			return nil, err
		}
		if img != nil {
			return img, nil
		}
	}
	return nil, fmt.Errorf("screen capture produced no frame after %d attempts (session may have no capturable desktop)", attempts)
}
