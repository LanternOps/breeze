package tools

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// ComputerAction executes an input action using a standalone capturer.
// Use ComputerActionWithCapture when a WebRTC session may be active.
func ComputerAction(payload map[string]any) CommandResult {
	return ComputerActionWithCapture(payload, nil)
}

// ComputerActionWithCapture executes an input action on the device and
// optionally captures a screenshot afterward. If capFn is non-nil and
// succeeds, it reuses the active session's capturer for the screenshot
// instead of creating a new one (which would conflict with the WebRTC
// session's capture pipeline).
func ComputerActionWithCapture(payload map[string]any, capFn CaptureFunc) CommandResult {
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

	// The AI sends coordinates in screenshot image space (e.g., 1920x1080
	// after scaling). If the actual screen is larger (e.g., 2560x1440),
	// we need to scale the coordinates up. The AI can provide the image
	// dimensions via coordinateSpaceWidth/Height so we know what to scale from.
	coordW := GetPayloadInt(payload, "coordinateSpaceWidth", 0)
	coordH := GetPayloadInt(payload, "coordinateSpaceHeight", 0)
	if coordW > 0 && coordH > 0 {
		// Get actual screen resolution for the target monitor
		screenW, screenH := desktop.GetScreenResolution(monitor)
		if screenW > 0 && screenH > 0 && (screenW != coordW || screenH != coordH) {
			scaleX := float64(screenW) / float64(coordW)
			scaleY := float64(screenH) / float64(coordH)
			x = int(float64(x) * scaleX)
			y = int(float64(y) * scaleY)
			slog.Debug("scaled coordinates from image to screen space",
				"origX", GetPayloadInt(payload, "x", 0),
				"origY", GetPayloadInt(payload, "y", 0),
				"scaledX", x, "scaledY", y,
				"coordSpace", fmt.Sprintf("%dx%d", coordW, coordH),
				"screenSpace", fmt.Sprintf("%dx%d", screenW, screenH),
			)
		}
	}

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
		screenshot, err := captureScreenshotWithFn(monitor, capFn)
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
		// Prefer TypeChar (Unicode input) for each character — handles all
		// characters including ":", "!", "@", non-ASCII, etc. Fall back to
		// SendKeyPress for platforms without TypeChar support.
		typer, hasTyper := input.(desktop.TypeCharHandler)
		for _, ch := range text {
			if hasTyper {
				if err := typer.TypeChar(ch); err != nil {
					return fmt.Errorf("failed typing character %q: %w", string(ch), err)
				}
			} else {
				if err := input.SendKeyPress(string(ch), nil); err != nil {
					return fmt.Errorf("failed typing character %q: %w", string(ch), err)
				}
			}
		}
		return nil

	default:
		return fmt.Errorf("unknown action: %s", action)
	}
}

// captureScreenshotWithFn captures a screenshot, preferring capFn if provided.
// Falls back to creating a standalone capturer when capFn is nil or fails.
func captureScreenshotWithFn(monitor int, capFn CaptureFunc) (*ScreenshotResponse, error) {
	var img *image.RGBA
	var width, height int

	// Try injected capture function first (reuses active session's capturer)
	if capFn != nil {
		var err error
		img, width, height, err = capFn(monitor)
		if err == nil {
			return encodeScreenshotResponse(img, width, height, monitor)
		}
		// Only fall back to standalone capturer if no session exists.
		// If a session IS active but errored, standalone would destroy its
		// shared global capture state — the exact bug this fix prevents.
		if !errors.Is(err, desktop.ErrNoActiveSession) {
			slog.Warn("session capturer failed (standalone fallback unsafe)",
				"monitor", monitor, "error", err.Error())
			return nil, fmt.Errorf("active session capture failed: %w", err)
		}
	}

	// Standalone capture path
	cfg := desktop.DefaultConfig()
	cfg.Quality = 85
	cfg.DisplayIndex = monitor

	capturer, err := desktop.NewScreenCapturer(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create screen capturer: %w", err)
	}
	defer capturer.Close()

	img, err = capturer.Capture()
	if err != nil {
		return nil, fmt.Errorf("failed to capture screen: %w", err)
	}
	if img == nil {
		return nil, fmt.Errorf("capturer returned nil image")
	}

	width, height, err = capturer.GetScreenBounds()
	if err != nil {
		return nil, fmt.Errorf("failed to get screen bounds: %w", err)
	}

	return encodeScreenshotResponse(img, width, height, monitor)
}

