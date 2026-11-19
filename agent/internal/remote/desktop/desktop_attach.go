package desktop

import (
	"errors"
	"fmt"
	"time"
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

// setThreadDesktopFailure is a failed SetThreadDesktop. It is its own type so
// the recycle rule can tell an attach failure apart from a GDI call that fails
// with the same Win32 code: BitBlt, CreateDC and GdiFlush wrap a
// syscall.Errno too, and their 170 says nothing about the thread's desktop.
type setThreadDesktopFailure struct {
	code uint32 // the Win32 code, 0 when none was recorded
	err  error  // the formatted error, unwrappable to the syscall.Errno
}

func (e *setThreadDesktopFailure) Error() string { return e.err.Error() }
func (e *setThreadDesktopFailure) Unwrap() error { return e.err }

// setThreadDesktopError builds the error for a failed SetThreadDesktop that
// tried to move a thread from desktop `from` to desktop `to`. It carries the
// Win32 code (decimal and hex, unwrappable to syscall.Errno) and both desktop
// names, which is the whole of what a technician needs to tell the failure
// modes apart from a helper log.
func setThreadDesktopError(from, to string, errno error) error {
	op := fmt.Sprintf("SetThreadDesktop from %s to %s", quoteDesktopName(from), quoteDesktopName(to))
	err := gdiCallError(op, errno)
	code, _ := win32ErrorCode(err)
	if hint := setThreadDesktopHint(code); hint != "" {
		err = fmt.Errorf("%w [%s]", err, hint)
	}
	return &setThreadDesktopFailure{code: code, err: err}
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
//
// It matches the SetThreadDesktop failure itself, not the code anywhere in the
// chain: a BitBlt, CreateDC or GdiFlush that fails with 170 is not an attach
// failure, and retiring the thread for it cures nothing.
func shouldRecycleCaptureThread(err error) bool {
	var f *setThreadDesktopFailure
	return errors.As(err, &f) && f.code == errBusy
}

// Bounds on retiring a capture thread after an ERROR_BUSY attach. The first
// recycle of a streak is immediate and the next waits the minimum interval,
// which is shorter than the startup probe's 200ms retry so a fresh thread is
// ready for the probe's next attempt. Each further recycle doubles the wait,
// up to the maximum: ERROR_BUSY that survives several fresh threads is not a
// property of the thread, and recycling at a fixed 150ms would create and kill
// an OS thread about six times a second for as long as it lasted.
const (
	captureThreadRecycleMinInterval = 150 * time.Millisecond
	captureThreadRecycleMaxInterval = 30 * time.Second
	captureThreadRecycleLogInterval = 30 * time.Second
)

// captureThreadRecycleDelay is how long a capturer waits after the streak-th
// consecutive recycle before it may recycle again.
func captureThreadRecycleDelay(streak int) time.Duration {
	if streak <= 0 {
		return 0
	}
	d := captureThreadRecycleMinInterval
	for i := 1; i < streak && d < captureThreadRecycleMaxInterval; i++ {
		d *= 2
	}
	return min(d, captureThreadRecycleMaxInterval)
}

// captureThreadRecycler decides when a capturer retires its capture thread
// (ERROR_BUSY attach, or a panic on the thread) and when that is worth a Warn.
// The streak runs until a frame is delivered.
type captureThreadRecycler struct {
	streak  int       // recycles since the last delivered frame
	last    time.Time // when the last recycle happened
	lastLog time.Time
}

// decide reports whether to retire the thread now, and whether to log it: the
// first recycle of a streak is logged, then at most one per log interval.
func (r *captureThreadRecycler) decide(now time.Time) (recycle, logIt bool) {
	if r.backingOff(now) {
		return false, false
	}
	r.streak++
	r.last = now
	if r.streak == 1 || now.Sub(r.lastLog) >= captureThreadRecycleLogInterval {
		r.lastLog = now
		return true, true
	}
	return true, false
}

// backingOff reports whether a recycle at now would fall inside the wait after
// the streak's last recycle.
func (r captureThreadRecycler) backingOff(now time.Time) bool {
	return r.streak > 0 && now.Sub(r.last) < captureThreadRecycleDelay(r.streak)
}

// reset ends the streak; called when a frame is delivered.
func (r *captureThreadRecycler) reset() { *r = captureThreadRecycler{} }

// unverifiedDesktopLogInterval throttles the Warn for frames delivered while
// the capture thread could not confirm it was on the input desktop.
const unverifiedDesktopLogInterval = 30 * time.Second

// unverifiedInputDesktopError is what CaptureWarning reports while a
// capturer is delivering frames it took without confirming the capture thread
// was on the input desktop. Those frames are sent, because the thread is most
// likely still on the right desktop, but one taken on the wrong desktop is
// black or shows the wrong screen, and this is the only place that says why.
type unverifiedInputDesktopError struct {
	frames int
	cause  error
}

func (e *unverifiedInputDesktopError) Error() string {
	noun := "frames"
	if e.frames == 1 {
		noun = "frame"
	}
	return fmt.Sprintf("%d %s captured without confirming the input desktop, so the picture may be black or show the wrong desktop: %v",
		e.frames, noun, e.cause)
}

func (e *unverifiedInputDesktopError) Unwrap() error { return e.cause }

// unverifiedFrameLog is what a delivered frame asks the capturer to log.
type unverifiedFrameLog int

const (
	unverifiedFrameNoLog        unverifiedFrameLog = iota
	unverifiedFrameLogWarn                         // a streak began, its cause changed, or the periodic reminder
	unverifiedFrameLogRecovered                    // the input desktop was confirmed again after a streak
)

func (k unverifiedFrameLog) String() string {
	switch k {
	case unverifiedFrameLogWarn:
		return "warn"
	case unverifiedFrameLogRecovered:
		return "recovered"
	}
	return "none"
}

// unverifiedDesktopFrames counts the frames a capturer has delivered since its
// capture thread last confirmed it was on the input desktop (#8434 review).
// Before it, a frame taken after OpenInputDesktop failed, or with an
// unreadable desktop name, was reported as a clean success, and the reason
// surfaced only if a later frame failed.
type unverifiedDesktopFrames struct {
	frames  int
	cause   error
	lastLog time.Time
}

// frameDelivered records one delivered frame. cause is nil when the thread
// confirmed it was on the input desktop, else why it could not. It returns
// what to log and the frame count that goes with it: the streak so far for a
// Warn, the streak that just ended for a recovery.
func (u *unverifiedDesktopFrames) frameDelivered(cause error, now time.Time) (unverifiedFrameLog, int) {
	if cause == nil {
		ended := u.frames
		*u = unverifiedDesktopFrames{}
		if ended > 0 {
			return unverifiedFrameLogRecovered, ended
		}
		return unverifiedFrameNoLog, 0
	}
	changed := u.cause == nil || u.cause.Error() != cause.Error()
	u.frames++
	u.cause = cause
	if changed || now.Sub(u.lastLog) >= unverifiedDesktopLogInterval {
		u.lastLog = now
		return unverifiedFrameLogWarn, u.frames
	}
	return unverifiedFrameNoLog, u.frames
}

// err is the warning to report through CaptureWarning while the latest
// frames are unverified, or nil once a frame is confirmed.
func (u *unverifiedDesktopFrames) err() error {
	if u.frames == 0 {
		return nil
	}
	return &unverifiedInputDesktopError{frames: u.frames, cause: u.cause}
}
