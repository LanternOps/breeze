package desktop

import (
	"errors"
	"fmt"
	"syscall"
)

// SetThreadDesktop failure reporting, shared by every place a capture thread
// is moved onto the input desktop.
//
// No build tag, for the reason capture_gdi.go carries none: this is pure Go
// over error values, and the Windows-only callers live in files no CI job
// executes, so the formatting is asserted here on the Linux runner.
//
// Why it exists (#8434, #9558): checkDesktopSwitch discarded the Win32 error
// from SetThreadDesktop (`ret, _, _ :=`), so a helper log could say the switch
// to Winlogon failed but never why, and the two plausible causes need opposite
// fixes. ERROR_BUSY means the thread owns windows or hooks on its current
// desktop and a different thread would succeed; ERROR_ACCESS_DENIED means the
// process token cannot reach the desktop at all.

// Win32 error codes SetThreadDesktop is known to return.
const (
	errAccessDenied     = 5
	errInvalidHandle    = 6
	errInvalidParameter = 87
	errBusy             = 170
)

// setThreadDesktopHint names what a SetThreadDesktop error code means, or ""
// when the code is not one this package recognises. A hint is only given for
// codes whose meaning for this call is documented; an unknown code is reported
// as a number and nothing else, rather than with a guessed cause.
func setThreadDesktopHint(code uint32) string {
	switch code {
	case errBusy:
		return "the thread owns windows or hooks on its current desktop"
	case errAccessDenied:
		return "access denied to the target desktop"
	case errInvalidHandle:
		return "invalid desktop handle"
	case errInvalidParameter:
		return "invalid parameter"
	}
	return ""
}

// setThreadDesktopError builds the error for a failed SetThreadDesktop that
// tried to move a thread from desktop `from` to desktop `to`. It carries the
// Win32 code (decimal and hex, unwrappable to syscall.Errno) and both desktop
// names, which is the whole of what a technician needs to tell the failure
// modes apart from a helper log.
func setThreadDesktopError(from, to string, errno error) error {
	op := fmt.Sprintf("SetThreadDesktop from %s to %s", quoteDesktopName(from), quoteDesktopName(to))
	err := gdiCallError(op, errno)
	if code, ok := win32ErrorCode(err); ok {
		if hint := setThreadDesktopHint(code); hint != "" {
			return fmt.Errorf("%w [%s]", err, hint)
		}
	}
	return err
}

// quoteDesktopName renders a desktop name for an error message. An empty name
// means GetUserObjectInformationW could not read it, which is said outright
// rather than printed as "".
func quoteDesktopName(name string) string {
	if name == "" {
		return "(unknown desktop)"
	}
	return fmt.Sprintf("%q", name)
}

// shouldRecycleCaptureThread reports whether a failed desktop attach is one a
// fresh OS thread would not hit. Only ERROR_BUSY qualifies: it is a property of
// the thread (it owns windows or hooks), so retiring that thread and starting
// another cures it. Every other failure is a property of the process or the
// desktop, and recycling would only churn threads.
func shouldRecycleCaptureThread(err error) bool {
	var e syscall.Errno
	return errors.As(err, &e) && e == errBusy
}
