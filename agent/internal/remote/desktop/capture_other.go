//go:build !darwin && !windows && !linux

package desktop

import (
	"image"
)

// otherCapturer is a stub for unsupported platforms
type otherCapturer struct {
	config CaptureConfig
}

// newPlatformCapturer returns an error on unsupported platforms
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return nil, ErrNotSupported
}
