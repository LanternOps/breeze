//go:build !windows

package desktop

// forceDesktopRepaint is a no-op on non-Windows platforms.
// DXGI Desktop Duplication is Windows-only.
func forceDesktopRepaint() {}

// nudgeSecureDesktop is a no-op on non-Windows platforms.
func nudgeSecureDesktop() {}

// newProbeRepainter is a no-op on non-Windows platforms: macOS CGDisplayStream
// and Linux X11 capture return a frame for an idle desktop, so the startup
// probe has nothing to shake loose and no thread desktop to attach to.
func newProbeRepainter() (repaint func(), release func()) {
	return func() {}, func() {}
}
