package tools

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"testing"
)

// A live session that cannot serve the frame (#12624: the capture loop timed
// out, the session is stopping, or its capturer failed) must be reported as
// an active-session capture failure. Falling back to a standalone capturer
// while the session's own is live is what screenshot.go forbids.
func sessionBusyCapture(int) (*image.RGBA, int, int, error) {
	return nil, 0, 0, fmt.Errorf("capture from active session: %w",
		errors.New("timed out waiting for the desktop session's capture loop"))
}

func TestTakeScreenshotWithCapture_SessionErrorNoStandaloneFallback(t *testing.T) {
	result := TakeScreenshotWithCapture(map[string]any{}, sessionBusyCapture)
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "active session capture failed") ||
		!strings.Contains(result.Error, "timed out waiting") {
		t.Fatalf("error = %q, want the active-session failure with its cause", result.Error)
	}
}

func TestCaptureScreenshotWithFn_SessionErrorNoStandaloneFallback(t *testing.T) {
	_, err := captureScreenshotWithFn(0, sessionBusyCapture)
	if err == nil || !strings.Contains(err.Error(), "active session capture failed") {
		t.Fatalf("err = %v, want the active-session failure", err)
	}
}
