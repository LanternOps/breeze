//go:build !windows

package desktop

// prepareCaptureThread is a no-op on non-Windows platforms.
// Desktop switching is a Windows-specific concern for service/helper processes.
func prepareCaptureThread() {}
