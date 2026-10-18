//go:build !darwin || !cgo

package desktop

// CheckCaptureAccess has nothing to check off macOS: capture needs no
// per-process grant there, and the macOS helper built without cgo cannot
// capture at all, so its sessions fail on their own.
func CheckCaptureAccess(CaptureConfig) CaptureAccessReport {
	return CaptureAccessReport{State: CaptureAccessGranted, Reason: "platform"}
}
