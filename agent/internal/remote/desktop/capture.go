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

// BGRAProvider is implemented by capturers that produce BGRA pixel data
// (stored in image.RGBA.Pix). This lets the encoder skip the BGRA→RGBA
// conversion and go directly to BGRA→NV12.
type BGRAProvider interface {
	IsBGRA() bool
}

// TightLoopHint is implemented by capturers that internally block waiting for
// new frames (e.g. DXGI AcquireNextFrame). This allows the caller to run a
// tight capture loop without a ticker.
//
// Implementations should return false when operating in a non-blocking fallback
// mode (e.g. DXGI capturer falling back to GDI) to avoid busy loops.
type TightLoopHint interface {
	TightLoop() bool
}

// FrameChangeHint is implemented by capturers that can report whether new
// frames are available without a full pixel-level comparison (e.g. DXGI
// AccumulatedFrames). When Capture() returns nil,nil the caller should skip
// encoding entirely.
type FrameChangeHint interface {
	AccumulatedFrames() uint32
}

// TextureProvider is implemented by capturers that can provide raw GPU
// textures for zero-copy GPU encoding pipelines.
type TextureProvider interface {
	// CaptureTexture acquires a frame and copies it to the staging texture.
	// Returns a BGRA GPU texture handle. Returns 0, nil when no new frame
	// is available. Caller must call ReleaseTexture() when done.
	CaptureTexture() (texture uintptr, err error)
	// ReleaseTexture releases the DXGI frame acquired by CaptureTexture.
	ReleaseTexture()
	// GetD3D11Device returns the D3D11 device handle.
	GetD3D11Device() uintptr
	// GetD3D11Context returns the immediate device context handle.
	GetD3D11Context() uintptr
}

// CursorProvider is implemented by capturers that can report the system cursor
// position for real-time cursor streaming to the viewer. This enables the viewer
// to render the cursor as a local overlay independent of the video frame rate.
type CursorProvider interface {
	CursorPosition() (x, y int32, visible bool)
}

// DesktopSwitchNotifier is implemented by capturers that detect Windows desktop
// transitions (Default ↔ Winlogon/Screen-saver). This enables the session to
// reset cursor/input offsets and force keyframes on secure desktop transitions.
type DesktopSwitchNotifier interface {
	// ConsumeDesktopSwitch returns true once after each desktop switch.
	ConsumeDesktopSwitch() bool
	// OnSecureDesktop returns true when capturing a secure desktop (Winlogon, Screen-saver).
	OnSecureDesktop() bool
}

// ErrNotSupported is returned when screen capture is not supported on the platform
var ErrNotSupported = fmt.Errorf("screen capture not supported on this platform")

// ErrPermissionDenied is returned when screen capture permissions are not granted
var ErrPermissionDenied = fmt.Errorf("screen capture permission denied")

// ErrDisplayNotFound is returned when the specified display is not found
var ErrDisplayNotFound = fmt.Errorf("display not found")
