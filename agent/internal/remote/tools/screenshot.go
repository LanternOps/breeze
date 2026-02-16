package tools

import (
	"encoding/base64"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// TakeScreenshot captures a screenshot of the specified monitor and returns
// it as a base64-encoded JPEG. The image is scaled down to at most 1920px
// wide and re-encoded at lower quality if the result exceeds 1MB.
func TakeScreenshot(payload map[string]any) CommandResult {
	start := time.Now()

	monitor := GetPayloadInt(payload, "monitor", 0)

	cfg := desktop.DefaultConfig()
	cfg.Quality = 85
	cfg.DisplayIndex = monitor

	capturer, err := desktop.NewScreenCapturer(cfg)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to create screen capturer: %w", err), time.Since(start).Milliseconds())
	}
	defer capturer.Close()

	img, err := capturer.Capture()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to capture screen: %w", err), time.Since(start).Milliseconds())
	}

	width, height, err := capturer.GetScreenBounds()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to get screen bounds: %w", err), time.Since(start).Milliseconds())
	}

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
