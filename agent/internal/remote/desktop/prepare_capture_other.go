//go:build !windows

package desktop

// prepareCaptureThread is a no-op on non-Windows platforms.
// Desktop switching is a Windows-specific concern for service/helper processes.
func prepareCaptureThread() {}

// switchThreadToInputDesktop is a no-op stub on non-Windows platforms.
// The capture-loop watchdog calls this before forcing a capturer re-attach;
// on macOS/Linux there is no concept of a "thread desktop" to re-attach to.
func switchThreadToInputDesktop() bool { return false }
