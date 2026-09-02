package desktop

import (
	"fmt"
	"image"
	"log/slog"
	"time"
)

// probeCapture validates that a capturer can actually produce a frame before
// a WebRTC answer is returned. The GDI fallback reports transient failures as
// (nil, nil) — "no frame yet" — which the streaming loop tolerates, but the
// startup probe must not: a session in a non-capturable Windows session (e.g.
// no input desktop) would otherwise start and stream black. Nil-frame results
// are retried with a short delay to ride out secure-desktop transitions; a
// hard error fails immediately.
//
// repaint is invoked immediately before every capture attempt, including the
// first. DXGI Desktop Duplication only hands back a frame when desktop content
// *changes*, so a perfectly capturable but idle desktop answers
// DXGI_ERROR_WAIT_TIMEOUT for the whole probe budget and the session aborts
// with "no capturable desktop" even though nothing is wrong (#3951). The
// streaming loop has always known this and forces a repaint in eleven places
// in session_capture.go; the startup probe forced one in none. A nil repaint is
// allowed for callers that have nothing to shake loose.
//
// The retry ceiling and the genuine-failure path are unchanged: a hard capture
// error (device lost, no output, access denied) still aborts on the first
// attempt with the underlying error.
func probeCapture(capture func() (*image.RGBA, error), attempts int, delay time.Duration, repaint func()) (*image.RGBA, error) {
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(delay)
		}
		// Force a repaint before the capture, not after: RedrawWindow with
		// RDW_UPDATENOW processes WM_PAINT synchronously, so the dirty rects
		// are already queued for DXGI by the time AcquireNextFrame runs.
		if repaint != nil {
			repaint()
		}
		img, err := capture()
		if err != nil {
			return nil, err
		}
		if img != nil {
			if i > 0 {
				slog.Debug("Capture probe produced a frame after retry",
					"attempt", i+1, "attempts", attempts)
			}
			return img, nil
		}
	}
	return nil, fmt.Errorf("screen capture produced no frame after %d attempts with forced desktop repaints (session may have no capturable desktop)", attempts)
}
