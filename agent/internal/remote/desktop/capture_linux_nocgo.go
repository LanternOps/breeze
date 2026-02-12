//go:build linux && !cgo

package desktop

// newPlatformCapturer returns an error on Linux when built without CGO,
// since screen capture requires X11 libraries via CGO.
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return nil, ErrNotSupported
}
