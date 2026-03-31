package tools

import (
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

const maxScreenshotBase64Bytes = 1_000_000

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
		// Only fall back to standalone capturer if no session exists.
		// If a session IS active but errored, standalone would destroy its
		// shared global capture state — the exact bug this fix prevents.
		if !errors.Is(err, desktop.ErrNoActiveSession) {
			slog.Warn("session capturer failed (standalone fallback unsafe)",
				"monitor", monitor, "error", err.Error())
			return NewErrorResult(fmt.Errorf("active session capture failed: %w", err), time.Since(start).Milliseconds())
		}
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

// encodeScreenshot scales, encodes, and packages a captured image as a CommandResult.
func encodeScreenshot(img *image.RGBA, width, height, monitor int, start time.Time) CommandResult {
	resp, err := encodeScreenshotResponse(img, width, height, monitor)
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return NewSuccessResult(*resp, time.Since(start).Milliseconds())
}

// encodeScreenshotResponse scales and encodes an image into a ScreenshotResponse.
// Used by both screenshot and computer_action encoding paths.
func encodeScreenshotResponse(img *image.RGBA, width, height, monitor int) (*ScreenshotResponse, error) {
	// Preserve original screen resolution for mouse coordinate mapping.
	// The AI must send click coordinates in screen space, not image space.
	screenWidth := width
	screenHeight := height

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
		return nil, fmt.Errorf("failed to encode screenshot: %w", err)
	}

	b64 := base64.StdEncoding.EncodeToString(jpegData)

	// Re-encode at lower quality if base64 exceeds the transport budget.
	if len(b64) > maxScreenshotBase64Bytes {
		jpegData, err = desktop.EncodeJPEG(img, 60)
		if err != nil {
			return nil, fmt.Errorf("failed to re-encode screenshot: %w", err)
		}
		b64 = base64.StdEncoding.EncodeToString(jpegData)
	}
	if len(b64) > maxScreenshotBase64Bytes {
		return nil, fmt.Errorf("screenshot exceeds maximum encoded size of %d bytes", maxScreenshotBase64Bytes)
	}

	return &ScreenshotResponse{
		ImageBase64:  b64,
		Width:        width,
		Height:       height,
		ScreenWidth:  screenWidth,
		ScreenHeight: screenHeight,
		Format:       "jpeg",
		SizeBytes:    len(jpegData),
		Monitor:      monitor,
		CapturedAt:   time.Now().UTC().Format(time.RFC3339),
	}, nil
}
