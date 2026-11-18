package desktop

import "time"

// No build tag: the decision behind DXGI's GDI-fallback repair
// (dxgiCapturer.captureFromGDIFallbackLocked) is pure Go, so it is asserted
// on every OS (#8434 review).
//
// The repair replaces the GDI fallback — and so its capture thread — after a
// run of frameless samples. Every GDI capturer in production is that
// fallback, so the repair is also the thing that decides how often a capture
// thread is replaced: before it consulted the fallback's recycler, it
// replaced the fallback every 500ms under persistent ERROR_BUSY with a fresh
// recycler each time, and the backoff never took effect.

// Thresholds for the no-frame repair.
const (
	gdiFallbackRepairNoFrames = 15
	gdiFallbackRepairInterval = 500 * time.Millisecond
)

// gdiRepairCarry is what a repaired GDI fallback hands its replacement: the
// swallowed capture error, without which StartSession would tell the
// technician only "no frame after N attempts" (#5284), and the capture-thread
// recycler (streak, time of the last recycle, time of the last Warn), without
// which the replacement would restart the backoff and the Warn throttle.
type gdiRepairCarry struct {
	lastCaptureErr error
	recycler       captureThreadRecycler
}

// gdiFallbackRepairDue reports whether captureFromGDIFallbackLocked should
// replace the GDI fallback now: after gdiFallbackRepairNoFrames frameless
// samples, at most once per gdiFallbackRepairInterval, and never while the
// fallback is waiting out its capture-thread recycle backoff. The fallback
// retires its own thread when that backoff ends, so leaving it alone keeps a
// recovered desktop waiting no longer than the current backoff, while a
// replacement inside it would only be one more OS thread the backoff exists
// to prevent.
func gdiFallbackRepairDue(noFrames int, lastRepair time.Time, fallback gdiRepairCarry, now time.Time) bool {
	if noFrames < gdiFallbackRepairNoFrames || now.Sub(lastRepair) < gdiFallbackRepairInterval {
		return false
	}
	return !fallback.recycler.backingOff(now)
}

// repairCarry is what this fallback hands to its replacement.
func (b *gdiCaptureBook) repairCarry() gdiRepairCarry {
	return gdiRepairCarry{lastCaptureErr: b.lastCaptureErr, recycler: b.recycler}
}

// adoptRepairCarry takes over what a repaired fallback handed on. Called on a
// new capturer before its first capture.
func (b *gdiCaptureBook) adoptRepairCarry(c gdiRepairCarry) {
	b.lastCaptureErr = c.lastCaptureErr
	b.recycler = c.recycler
}
