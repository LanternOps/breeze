package desktop

import (
	"fmt"
	"image"
)

// ScreenCapturer defines the interface for screen capture implementations
type ScreenCapturer interface {
	// Capture captures the screen and returns an image
	Capture() (*image.RGBA, error)

	// CaptureRegion captures a specific region of the screen
	CaptureRegion(x, y, width, height int) (*image.RGBA, error)

	// GetScreenBounds returns the screen dimensions
	GetScreenBounds() (width, height int, err error)

	// Close releases any resources held by the capturer
	Close() error
}

// CaptureConfig holds configuration for screen capture
type CaptureConfig struct {
	// DisplayIndex specifies which display to capture (0 = primary)
	DisplayIndex int

	// Quality specifies the JPEG quality (1-100) if encoding to JPEG
	Quality int

	// ScaleFactor for downscaling the capture (1.0 = full resolution)
	ScaleFactor float64
}

// DefaultConfig returns a default capture configuration
func DefaultConfig() CaptureConfig {
	return CaptureConfig{
		DisplayIndex: 0,
		Quality:      80,
		ScaleFactor:  1.0,
	}
}

// NewScreenCapturer creates a new platform-specific screen capturer
func NewScreenCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return newPlatformCapturer(config)
}

// ErrNotSupported is returned when screen capture is not supported on the platform
var ErrNotSupported = fmt.Errorf("screen capture not supported on this platform")

// ErrPermissionDenied is returned when screen capture permissions are not granted
var ErrPermissionDenied = fmt.Errorf("screen capture permission denied")

// ErrDisplayNotFound is returned when the specified display is not found
var ErrDisplayNotFound = fmt.Errorf("display not found")
