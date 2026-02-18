package tools

import (
	"encoding/base64"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// ComputerAction executes an input action on the device and optionally
// captures a screenshot afterward. This gives Claude full computer-use
// capabilities through a single atomic command round-trip.
func ComputerAction(payload map[string]any) CommandResult {
	start := time.Now()

	action := GetPayloadString(payload, "action", "")
	if action == "" {
		return NewErrorResult(fmt.Errorf("missing required field: action"), 0)
	}

	x := GetPayloadInt(payload, "x", 0)
	y := GetPayloadInt(payload, "y", 0)
	text := GetPayloadString(payload, "text", "")
	key := GetPayloadString(payload, "key", "")
	modifiers := GetPayloadStringSlice(payload, "modifiers")
	scrollDelta := GetPayloadInt(payload, "scrollDelta", 0)
	monitor := GetPayloadInt(payload, "monitor", 0)
	captureAfter := GetPayloadBool(payload, "captureAfter", true)
	captureDelayMs := GetPayloadInt(payload, "captureDelayMs", 500)

	// Clamp capture delay
	if captureDelayMs < 0 {
		captureDelayMs = 0
	}
	if captureDelayMs > 3000 {
		captureDelayMs = 3000
	}

	// Execute the input action (skip for screenshot-only)
	if action != "screenshot" {
		if err := executeInputAction(action, x, y, text, key, modifiers, scrollDelta); err != nil {
			return NewErrorResult(fmt.Errorf("input action %q failed: %w", action, err), time.Since(start).Milliseconds())
		}

		// Wait for UI to settle before capturing
		if captureAfter && captureDelayMs > 0 {
			time.Sleep(time.Duration(captureDelayMs) * time.Millisecond)
		}
	}

	resp := ComputerActionResponse{
		ActionExecuted: action,
	}

	// Capture screenshot if requested
	if captureAfter {
		screenshot, err := captureScreenshot(monitor)
		if err != nil {
			resp.ScreenshotError = fmt.Sprintf("action succeeded but screenshot failed: %v", err)
		} else {
			resp.Screenshot = screenshot
		}
	}

	return NewSuccessResult(resp, time.Since(start).Milliseconds())
}

func executeInputAction(action string, x, y int, text, key string, modifiers []string, scrollDelta int) error {
	input := desktop.NewInputHandler()

	switch action {
	case "left_click":
		return input.SendMouseClick(x, y, "left")

	case "right_click":
		return input.SendMouseClick(x, y, "right")

	case "middle_click":
		return input.SendMouseClick(x, y, "middle")

	case "double_click":
		if err := input.SendMouseClick(x, y, "left"); err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond)
		return input.SendMouseClick(x, y, "left")

	case "mouse_move":
		return input.SendMouseMove(x, y)

	case "scroll":
		return input.SendMouseScroll(x, y, scrollDelta)

	case "key":
		if key == "" {
			return fmt.Errorf("key field is required for key action")
		}
		return input.SendKeyPress(key, modifiers)

	case "type":
		if text == "" {
			return fmt.Errorf("text field is required for type action")
		}
		for _, ch := range text {
			if err := input.SendKeyPress(string(ch), nil); err != nil {
				return fmt.Errorf("failed typing character %q: %w", string(ch), err)
			}
		}
		return nil

	default:
		return fmt.Errorf("unknown action: %s", action)
	}
}

func captureScreenshot(monitor int) (*ScreenshotResponse, error) {
	cfg := desktop.DefaultConfig()
	cfg.Quality = 85
	cfg.DisplayIndex = monitor

	capturer, err := desktop.NewScreenCapturer(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create screen capturer: %w", err)
	}
	defer capturer.Close()

	img, err := capturer.Capture()
	if err != nil {
		return nil, fmt.Errorf("failed to capture screen: %w", err)
	}

	width, height, err := capturer.GetScreenBounds()
	if err != nil {
		return nil, fmt.Errorf("failed to get screen bounds: %w", err)
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
		return nil, fmt.Errorf("failed to encode screenshot: %w", err)
	}

	b64 := base64.StdEncoding.EncodeToString(jpegData)

	// Re-encode at lower quality if base64 exceeds 1MB
	if len(b64) > 1_000_000 {
		jpegData, err = desktop.EncodeJPEG(img, 60)
		if err != nil {
			return nil, fmt.Errorf("failed to re-encode screenshot: %w", err)
		}
		b64 = base64.StdEncoding.EncodeToString(jpegData)
	}

	return &ScreenshotResponse{
		ImageBase64: b64,
		Width:       width,
		Height:      height,
		Format:      "jpeg",
		SizeBytes:   len(jpegData),
		Monitor:     monitor,
		CapturedAt:  time.Now().UTC().Format(time.RFC3339),
	}, nil
}
