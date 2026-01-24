//go:build !windows && !darwin && !linux

package desktop

import "image"

func newPlatformCapturer(mode CaptureMode, region image.Rectangle) (PlatformCapturer, error) {
	return nil, ErrNotSupported
}
