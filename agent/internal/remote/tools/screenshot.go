package tools

import (
	"encoding/base64"
	"fmt"
	"image"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// CaptureFunc captures a screenshot from an existing source (e.g. an active
// WebRTC session's capturer). Returns the image and its dimensions.
// Used to avoid creating a new ScreenCapturer that would conflict with the
// active desktop session's capture pipeline.
type CaptureFunc func(displayIndex int) (*image.RGBA, int, int, error)

// TakeScreenshot captures a screenshot using a standalone capturer.
// Use TakeScreenshotWithCapture when a WebRTC session may be active.
func TakeScreenshot(payload map[string]any) CommandResult {
	return TakeScreenshotWithCapture(payload, nil)
}

// TakeScreenshotWithCapture captures a screenshot of the specified monitor.
// If capFn is non-nil and succeeds, it reuses the active session's capturer.
// Otherwise falls back to creating a standalone capturer.
func TakeScreenshotWithCapture(payload map[string]any, capFn CaptureFunc) CommandResult {
	start := time.Now()

	monitor := GetPayloadInt(payload, "monitor", 0)

	var img *image.RGBA
	var width, height int

	// Try the injected capture function first (reuses active session's capturer)
	if capFn != nil {
		var err error
		img, width, height, err = capFn(monitor)
		if err == nil {
			return encodeScreenshot(img, width, height, monitor, start)
		}
		// Fall through to standalone capturer
	}

	// Standalone capture path (no active session)
	cfg := desktop.DefaultConfig()
	cfg.Quality = 85
	cfg.DisplayIndex = monitor

	capturer, err := desktop.NewScreenCapturer(cfg)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to create screen capturer: %w", err), time.Since(start).Milliseconds())
	}
	defer capturer.Close()

	img, err = capturer.Capture()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to capture screen: %w", err), time.Since(start).Milliseconds())
	}

	width, height, err = capturer.GetScreenBounds()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to get screen bounds: %w", err), time.Since(start).Milliseconds())
	}

	return encodeScreenshot(img, width, height, monitor, start)
}

// encodeScreenshot scales, encodes, and packages a captured image.
func encodeScreenshot(img *image.RGBA, width, height, monitor int, start time.Time) CommandResult {
	// Scale down if wider than 1920px
	if width > 1920 {
		factor := 1920.0 / float64(width)
		img = desktop.ScaleImageFast(img, factor)
		bounds := img.Bounds()
		width = bounds.Dx()
		height = bounds.Dy()
	}

	// Encode as JPEG at quality 85
	jpegData, err := desktop.EncodeJPEG(img, 85)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to encode screenshot: %w", err), time.Since(start).Milliseconds())
	}

	b64 := base64.StdEncoding.EncodeToString(jpegData)

	// Re-encode at lower quality if base64 exceeds 1MB
	if len(b64) > 1_000_000 {
		jpegData, err = desktop.EncodeJPEG(img, 60)
		if err != nil {
			return NewErrorResult(fmt.Errorf("failed to re-encode screenshot: %w", err), time.Since(start).Milliseconds())
		}
		b64 = base64.StdEncoding.EncodeToString(jpegData)
	}

	resp := ScreenshotResponse{
		ImageBase64: b64,
		Width:       width,
		Height:      height,
		Format:      "jpeg",
		SizeBytes:   len(jpegData),
		Monitor:     monitor,
		CapturedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	return NewSuccessResult(resp, time.Since(start).Milliseconds())
}
