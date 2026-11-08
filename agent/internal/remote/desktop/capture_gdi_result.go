package desktop

import (
	"errors"
	"image"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// No build tag, for the reason desktop_attach.go carries none: the GDI
// capturer itself is Windows-only, but what one capture attempt does to its
// bookkeeping is pure Go, and keeping it here is what lets the rules run on
// every OS's CI (#8434 review). gdiCapturer (capture_windows_nocgo.go) owns
// one gdiCaptureBook and touches it only under its own mutex, except warning,
// which is read without it.

// errGDICaptureNoImage is the frame error for an attempt that returned
// neither an image nor an error.
var errGDICaptureNoImage = errors.New("GDI capture produced no image")

// gdiCaptureBook is the GDI capturer's state between frames that is not Win32
// state: the capture-thread recycler, the run of frames delivered without the
// input desktop confirmed, the failure-log throttle, and the last error
// reported to the caller as a nil frame.
type gdiCaptureBook struct {
	recycler captureThreadRecycler

	// unverified counts the frames delivered since the capture thread last
	// confirmed it was on the input desktop; captureWarning reports it.
	unverified unverifiedDesktopFrames

	// Failure throttling for secure-desktop transient capture outages.
	consecutiveCaptureFailures int
	lastFailureLog             time.Time

	// lastCaptureErr is the most recent error reported to the caller as a nil
	// frame. Capture() deliberately swallows failures so a transient
	// secure-desktop outage does not kill a live session; keeping the error
	// here is what lets StartSession tell the technician WHY the startup probe
	// found no frame (see describeCaptureFailure).
	lastCaptureErr error

	// warning is unverified.err() as of the last change, published for
	// captureWarning to read without the capturer's lock: the periodic
	// metrics line reads it, and a wedged BitBlt or SetThreadDesktop holds
	// that lock (#8434 review). Written only where unverified changes, which
	// is under the lock; the value is never modified after it is stored.
	warning atomic.Pointer[unverifiedInputDesktopError]
}

// onCaptureResult applies one capture attempt. img and capErr are what the
// capture thread returned, or capErr is the error lockedThread.Do returned
// (errCaptureThreadPanicked for work that panicked); followIssue is why the
// thread could not confirm it was on the input desktop for this attempt, or
// nil. It reports whether img is to be delivered, and whether the capture
// thread must be retired before the next frame (ERROR_BUSY from
// SetThreadDesktop, or a panic, subject to the recycler's backoff).
func (b *gdiCaptureBook) onCaptureResult(img *image.RGBA, capErr, followIssue error, now time.Time) (deliver, retireThread bool) {
	if capErr == nil && img != nil {
		b.consecutiveCaptureFailures = 0
		b.lastCaptureErr = nil
		b.recycler.reset()
		b.noteFrameDelivered(followIssue, now)
		return true, false
	}
	if capErr == nil {
		capErr = errGDICaptureNoImage
	}
	if shouldRecycleCaptureThread(capErr) || errors.Is(capErr, errCaptureThreadPanicked) {
		retireThread = b.decideRecycle(capErr, now)
	}
	// Secure-desktop transitions can invalidate DCs transiently. The caller
	// treats this as "no frame yet" so the session loop skips without flooding
	// error logs. The startup probe (probeCapture) retries then fails on
	// persistent nil frames — and reads lastCaptureErr back out via
	// LastCaptureError so the technician is told which Win32 call failed and
	// with what code.
	b.recordCaptureFailure(capErr, now)
	return false, retireThread
}

// decideRecycle asks the recycler whether to retire the capture thread for
// cause now, and logs the recycles its throttle lets through. Recycles back
// off (captureThreadRecycler): a cause that survives fresh threads is not the
// thread's, and churning OS threads will not cure it.
func (b *gdiCaptureBook) decideRecycle(cause error, now time.Time) bool {
	recycle, warn := b.recycler.decide(now)
	if recycle && warn {
		attrs := []any{
			"error", cause.Error(),
			"consecutiveRecycles", b.recycler.streak,
			"nextRecycleAfter", captureThreadRecycleDelay(b.recycler.streak).String(),
		}
		if code, ok := win32ErrorCode(cause); ok {
			attrs = append(attrs, "win32Error", code)
		}
		slog.Warn("Retiring the GDI capture thread; the next frame starts a new thread", attrs...)
	}
	return recycle
}

// noteFrameDelivered records whether a delivered frame was taken with the
// input desktop confirmed, and logs a streak of frames that were not and its
// end.
func (b *gdiCaptureBook) noteFrameDelivered(followIssue error, now time.Time) {
	kind, frames := b.unverified.frameDelivered(followIssue, now)
	b.publishWarning()
	switch kind {
	case unverifiedFrameLogWarn:
		attrs := []any{"frames", frames, "error", followIssue.Error()}
		if code, ok := win32ErrorCode(followIssue); ok {
			attrs = append(attrs, "win32Error", code)
		}
		slog.Warn("GDI capture is delivering frames without confirming the input desktop; they may be black or show the wrong desktop", attrs...)
	case unverifiedFrameLogRecovered:
		// Info, so it ships only with ShipAlways: the streak's Warn ships at
		// the default level, and without this Agent Logs never show it ended.
		slog.Info("GDI capture thread confirmed the input desktop again", "unverifiedFrames", frames, logging.ShipAlways())
	}
}

func (b *gdiCaptureBook) recordCaptureFailure(err error, now time.Time) {
	b.consecutiveCaptureFailures++
	changed := b.lastCaptureErr == nil || b.lastCaptureErr.Error() != err.Error()
	b.lastCaptureErr = err
	// A different failure is always logged: the throttle exists to stop one
	// repeating error flooding the log, not to hide that the cause changed.
	if changed || b.consecutiveCaptureFailures == 1 || now.Sub(b.lastFailureLog) >= 2*time.Second {
		attrs := []any{
			"error", err.Error(),
			"consecutive", b.consecutiveCaptureFailures,
		}
		// Surface the Win32 code as its own field so it is greppable in a
		// helper log without parsing the message.
		if code, ok := win32ErrorCode(err); ok {
			attrs = append(attrs, "win32Error", code)
		}
		slog.Warn("GDI capture unavailable (returning no frame)", attrs...)
		b.lastFailureLog = now
	}
}

// publishWarning stores the current unverified.err() for captureWarning.
func (b *gdiCaptureBook) publishWarning() {
	if w, ok := b.unverified.err().(*unverifiedInputDesktopError); ok {
		b.warning.Store(w)
		return
	}
	b.warning.Store(nil)
}

// captureWarning is the CaptureWarning value: while frames are being delivered
// without the input desktop confirmed, why it could not be; else nil. Safe to
// call without the capturer's lock.
func (b *gdiCaptureBook) captureWarning() error {
	if w := b.warning.Load(); w != nil {
		return w
	}
	return nil
}

// reset is Close's half: a later capture starts over, with no recycle streak
// and no unconfirmed frames.
func (b *gdiCaptureBook) reset() {
	b.recycler.reset()
	b.unverified = unverifiedDesktopFrames{}
	b.publishWarning()
}
