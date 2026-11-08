package desktop

import (
	"strings"
	"time"
)

// isSecureDesktop returns true when the caller should fall back to GDI.
// Empty name means Win32 couldn't read it — this is a transient failure
// (common during desktop transitions), not a secure desktop. Callers
// should retry DXGI; if DXGI truly can't attach, initDXGI will fail on
// its own merits and the caller can fall to GDI then.
// "Default" (case-insensitive) is the normal user desktop; DXGI is safe.
// Anything else (Winlogon, Screen-saver, etc.) is a secure desktop.
func isSecureDesktop(desktopName string) bool {
	if desktopName == "" {
		return false
	}
	return !strings.EqualFold(desktopName, "Default")
}

// defaultAttachRetryInterval is how long checkDesktopSwitch leaves a failed
// switch to the Default desktop alone before trying again. See
// gdiAlreadyFollowsInputDesktop.
const defaultAttachRetryInterval = 5 * time.Second

// gdiAlreadyFollowsInputDesktop reports whether a capture thread / input
// desktop mismatch seen by checkDesktopSwitch is one that was already handled:
// the calling thread failed to follow the input desktop to followsDesktop and
// the GDI fallback's own thread attached there instead (#9558). Re-handling it
// would close and rebuild the fallback, thread and all, every 500ms tick for as
// long as the calling thread stays stuck.
//
// It never matches when there is no GDI fallback (nothing is following the
// desktop), when followsDesktop is unset, or once the input desktop has moved
// on to a different desktop, which is a real change.
//
// A secure desktop is suppressed for as long as it lasts: GDI is the backend
// there anyway. Default is suppressed only for defaultAttachRetryInterval
// after the failure, because Default is where DXGI belongs, and the only way
// back to it is for this thread's attach to succeed on a later attempt.
func gdiAlreadyFollowsInputDesktop(gdiActive bool, followsDesktop, inputName string, sinceAttachFailure time.Duration) bool {
	if !gdiActive || followsDesktop == "" || inputName == "" {
		return false
	}
	if !strings.EqualFold(followsDesktop, inputName) {
		return false
	}
	return isSecureDesktop(inputName) || sinceAttachFailure < defaultAttachRetryInterval
}
