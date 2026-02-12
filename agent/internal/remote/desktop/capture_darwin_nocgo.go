//go:build darwin && !cgo

package desktop

// newPlatformCapturer returns an error on macOS when built without CGO,
// since screen capture requires Objective-C frameworks via CGO.
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return nil, ErrNotSupported
}
