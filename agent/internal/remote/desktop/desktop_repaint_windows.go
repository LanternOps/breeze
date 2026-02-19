//go:build windows

package desktop

var (
	procInvalidateRect = user32.NewProc("InvalidateRect")
	procRedrawWindow   = user32.NewProc("RedrawWindow")
)

const (
	rdwInvalidate  = 0x0001
	rdwAllChildren = 0x0080
	rdwUpdateNow   = 0x0100
)

// forceDesktopRepaint forces all windows to repaint, generating dirty
// rectangles that DXGI Desktop Duplication will pick up on the next
// AcquireNextFrame call. This solves the black-screen issue when switching
// to a display with no active content (static wallpaper, no cursor).
func forceDesktopRepaint() {
	// InvalidateRect(NULL, NULL, TRUE) → marks all top-level windows as needing repaint
	procInvalidateRect.Call(0, 0, 1)

	// RedrawWindow with UPDATENOW forces immediate WM_PAINT processing
	// rather than waiting for the next message loop cycle.
	procRedrawWindow.Call(0, 0, 0,
		uintptr(rdwInvalidate|rdwAllChildren|rdwUpdateNow))
}
