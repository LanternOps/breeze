//go:build !darwin || !cgo

package desktop

// ScreenCaptureKitVerdict reports that this platform has no verdict.
func ScreenCaptureKitVerdict() ScreenCaptureKitVerdictStatus {
	return ScreenCaptureKitVerdictStatus{}
}

// ResetScreenCaptureKitVerdict is unsupported off macOS.
func ResetScreenCaptureKitVerdict() (path string, removed bool, err error) {
	return "", false, ErrCaptureVerdictUnsupported
}

// PinCoreGraphicsCapture is unsupported off macOS.
func PinCoreGraphicsCapture() (path string, err error) {
	return "", ErrCaptureVerdictUnsupported
}
