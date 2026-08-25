//go:build windows

package desktop

import (
	"log/slog"
	"runtime"
	"unsafe"
)

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

// nudgeSecureDesktop sends a tiny relative mouse jiggle via SendInput to wake
// up credential-provider UI on the Winlogon desktop. UAC consent, lock screen,
// and security options may not fully paint until they receive user input.
// A +1/-1 move pair is effectively invisible while still generating a real
// input transition for repaint-sensitive secure surfaces.
// Called from the capture loop after switching to a secure desktop to ensure
// the first frame contains rendered content.
func nudgeSecureDesktop() {
	nudges := [2]input{
		{inputType: INPUT_MOUSE},
		{inputType: INPUT_MOUSE},
	}
	nudges[0].mi.dx = 1
	nudges[0].mi.dy = 1
	nudges[0].mi.dwFlags = MOUSEEVENTF_MOVE
	nudges[1].mi.dx = -1
	nudges[1].mi.dy = -1
	nudges[1].mi.dwFlags = MOUSEEVENTF_MOVE

	ret, _, _ := sendInput.Call(
		uintptr(len(nudges)),
		uintptr(unsafe.Pointer(&nudges[0])),
		unsafe.Sizeof(nudges[0]),
	)
	if ret != uintptr(len(nudges)) {
		slog.Debug("nudgeSecureDesktop: SendInput did not inject full nudge sequence", "sent", ret)
	}
}

// newProbeRepainter returns the repaint callback for the startup capture probe
// (see probeCapture) plus a release func the caller MUST invoke once the probe
// returns — on the failure path too.
//
// The repaint itself is the same warm-up pair the capture loop uses on a static
// display: nudgeSecureDesktop followed by forceDesktopRepaint (session_capture.go).
// Both are needed — InvalidateRect has no HWND to target on a windowless
// desktop, and the SendInput jiggle is what makes the DWM compositor emit dirty
// rects there.
//
// The thread is pinned and attached to the input desktop ONCE, around the whole
// probe rather than per attempt, for two reasons. First, SendInput,
// InvalidateRect and RedrawWindow all act on the *calling thread's* desktop, and
// unlike the capture loop the probe does not run on a prepareCaptureThread
// goroutine — newPlatformCapturer releases its OS-thread lock once initDXGI
// succeeds, so Go may have migrated StartSession onto a thread that is not on
// the input desktop. Second, switchThreadToInputDesktop deliberately leaves its
// HDESK open (closing it would detach the thread), so calling it per attempt
// would leak one desktop handle per attempt.
func newProbeRepainter() (repaint func(), release func()) {
	runtime.LockOSThread()
	switchThreadToInputDesktop()
	return func() {
		nudgeSecureDesktop()
		forceDesktopRepaint()
	}, runtime.UnlockOSThread
}
