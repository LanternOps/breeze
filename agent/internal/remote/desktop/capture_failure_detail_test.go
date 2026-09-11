package desktop

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"testing"
)

// No build tag — see capture_gdi.go. describeCaptureFailure is the agent-side
// half of #5284: the GDI fallback swallows a failed frame as (nil, nil), so
// unless the swallowed error is re-attached here the technician is shown only
// probeCapture's generic "no frame after N attempts".

type stubCapturer struct{}

func (s *stubCapturer) Capture() (*image.RGBA, error) { return nil, nil }
func (s *stubCapturer) CaptureRegion(x, y, w, h int) (*image.RGBA, error) {
	return nil, nil
}
func (s *stubCapturer) GetScreenBounds() (int, int, error) { return 1920, 1080, nil }
func (s *stubCapturer) Close() error                       { return nil }

// reportingCapturer implements the optional lastCaptureErrorReporter.
type reportingCapturer struct {
	stubCapturer
	lastErr error
}

func (r *reportingCapturer) LastCaptureError() error { return r.lastErr }

func TestDescribeCaptureFailureAttachesSwallowedError(t *testing.T) {
	gdiErr := gdiCallError("GetDIBits", errnoForTest(5))
	probeErr := fmt.Errorf("screen capture produced no frame after 5 attempts")

	got := describeCaptureFailure(&reportingCapturer{lastErr: gdiErr}, probeErr)

	// The generic probe text must survive — callers and existing log greps
	// match on it.
	if !errors.Is(got, probeErr) {
		t.Fatalf("probe error must stay wrapped, got %v", got)
	}
	// ...and the swallowed Win32 detail must now be present, which is the whole
	// point: this string is what the viewer shows the technician.
	if !strings.Contains(got.Error(), "GetDIBits failed") {
		t.Errorf("swallowed capture error missing from %q", got)
	}
	if !strings.Contains(got.Error(), "5") {
		t.Errorf("Win32 error code missing from %q", got)
	}
	if !errors.Is(got, gdiErr) {
		t.Errorf("swallowed error must stay unwrappable, got %v", got)
	}
}

// The technician-facing string must stay readable. Handle values (an HDC or
// HBITMAP printed as a number) mean nothing to the reader and are what the
// maintainer explicitly asked to keep out of the viewer message.
func TestDescribeCaptureFailureStaysShortAndHandleFree(t *testing.T) {
	got := describeCaptureFailure(
		&reportingCapturer{lastErr: gdiCallError("GetDIBits", errnoForTest(5))},
		fmt.Errorf("screen capture produced no frame after 5 attempts with forced desktop repaints (session may have no capturable desktop)"),
	)
	// The API caps remote_sessions.errorMessage at 1024 bytes; the agent's own
	// wrapper adds ~60 more before it gets there.
	if n := len(got.Error()); n > 400 {
		t.Errorf("viewer-facing capture error is %d bytes, too long to read: %q", n, got)
	}
	for _, banned := range []string{"0x0000", "hdc", "HDC", "hBitmap", "memDC"} {
		if strings.Contains(got.Error(), banned) {
			t.Errorf("capture error leaks handle detail %q: %q", banned, got)
		}
	}
}

func TestDescribeCaptureFailurePassesThroughWhenNothingSwallowed(t *testing.T) {
	probeErr := fmt.Errorf("screen capture produced no frame after 5 attempts")

	// Capturer keeps no last error (e.g. DXGI, which returns real errors).
	if got := describeCaptureFailure(&reportingCapturer{lastErr: nil}, probeErr); got.Error() != probeErr.Error() {
		t.Errorf("with no swallowed error the probe error must pass through unchanged, got %q", got)
	}
	// Capturer does not implement the optional interface at all.
	if got := describeCaptureFailure(&stubCapturer{}, probeErr); got.Error() != probeErr.Error() {
		t.Errorf("non-reporting capturer must pass through unchanged, got %q", got)
	}
	// Nil probe error stays nil — a successful probe must never be turned into
	// a failure just because a transient frame was swallowed on the way.
	if got := describeCaptureFailure(&reportingCapturer{lastErr: fmt.Errorf("transient")}, nil); got != nil {
		t.Errorf("nil probe error must stay nil, got %v", got)
	}
}
