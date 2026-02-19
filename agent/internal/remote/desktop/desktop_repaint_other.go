//go:build !windows

package desktop

// forceDesktopRepaint is a no-op on non-Windows platforms.
// DXGI Desktop Duplication is Windows-only.
func forceDesktopRepaint() {}
