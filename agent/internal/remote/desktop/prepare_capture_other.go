//go:build !windows

package desktop

// prepareCaptureThread is a no-op on non-Windows platforms.
// Desktop switching is a Windows-specific concern for service/helper processes.
func prepareCaptureThread() {}

// switchThreadToInputDesktop is a no-op stub on non-Windows platforms.
// The capture-loop watchdog calls this before forcing a capturer re-attach;
// on macOS/Linux there is no concept of a "thread desktop" to re-attach to.
func switchThreadToInputDesktop() bool { return false }

// getCurrentInputDesktopName is a no-op stub on non-Windows platforms.
// On Windows, returns the active input desktop name (Default, Winlogon, etc.)
// so StartSession can choose an appropriate encoder for a locked screen.
// Non-Windows platforms have no concept of an input-desktop switch, so an
// empty string tells the caller "no special handling needed".
func getCurrentInputDesktopName() string { return "" }
