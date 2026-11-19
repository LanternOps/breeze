package desktop

import "time"

// Quality refresh after a burst on a static screen (#11639).
//
// Microsoft's software H264 MFT runs constant-bitrate rate control and is fed
// frame-count timestamps (frameIdx × frame duration), so its rate control
// only moves forward when a frame is submitted. A burst of large changes (a
// menu closing, a window moving) costs more than its per-frame budget: the
// buffer fills and the quantiser climbs, and the last frames of the burst are
// coded coarsely. Screen capture then submits nothing more until the screen
// changes again, so the encoder never gets the frames in which its buffer
// drains and the quantiser comes back down, and the viewer keeps the blocky
// picture (the taskbar clock stayed unreadable for minutes in the lab).
//
// The refresh gives it those frames. Once the screen has been static for
// qualityRefreshSettle after an expensive output, the encoder re-submits its
// last frame (the frame the idle catch-up already retains) once per idle
// capture iteration, for one second of stream time. Each re-submit advances
// the rate control by one frame and codes the difference between the source
// and the coarse picture the viewer has, so the picture sharpens as the
// quantiser drops; once it has converged a re-submit is a near-empty P-frame.
//
// Steady-state cost rule: only an output of at least half the per-frame
// budget, or an IDR, arms a refresh. Those are the outputs that can push CBR
// over budget and raise the quantiser. A clock tick or a blinking caret costs
// a small fraction of the budget, never arms one, and does not move the settle
// point of a refresh that is pending, so a near-static screen still costs one
// encode per change. A fully static screen costs nothing: a refresh runs once
// per expensive episode and then stops.

// qualityRefreshSettle is how long the screen must stay free of expensive
// outputs before a refresh starts, so motion is never padded with re-submits.
const qualityRefreshSettle = 300 * time.Millisecond

// qualityRefreshFrames is the number of re-submits in one refresh: one second
// of stream time at fps, which covers draining the 500 ms VBV buffer
// (vbvSizeForBitrate) and the quantiser steps back down after it. Clamped so
// a very low or very high frame rate keeps the refresh sensible.
func qualityRefreshFrames(fps int) int { return min(max(fps, 15), 60) }

// frameBudgetBytes is the CBR budget of one frame, in bytes.
func frameBudgetBytes(bitrate, fps int) int {
	if bitrate <= 0 || fps <= 0 {
		return 0
	}
	return bitrate / 8 / fps
}

// isExpensiveOutput reports whether an output can have pushed the rate
// control over budget: an IDR, or at least half of the frame budget. With an
// unknown budget only an IDR counts, so a misconfigured encoder errs on the
// side of not spending bandwidth.
func isExpensiveOutput(out []byte, budget int) bool {
	if len(out) == 0 {
		return false
	}
	if h264ContainsIDR(out) {
		return true
	}
	return budget > 0 && 2*len(out) >= budget
}

// qualityRefresh is the platform-neutral refresh state. The encoder reports
// every output that is not a refresh re-submit (noteOutput) and the result of
// every refresh re-submit (noteRefreshResult); the idle capture loop asks for
// a re-submit through nextIdleRefeed.
type qualityRefresh struct {
	// armed is set by an expensive output and cleared when the refresh has
	// spent its re-submits or was cancelled.
	armed bool
	// settleFrom is the time of the newest expensive output.
	settleFrom time.Time
	// remaining is the number of re-submits left in this refresh.
	remaining int
	// extended is set once an IDR inside the refresh renewed the budget, so a
	// stream of keyframes cannot keep a refresh going forever.
	extended bool
}

// noteOutput records an output that is not a refresh re-submit: a captured
// frame's, or one pushed out by the idle catch-up. An expensive one arms a
// fresh refresh that starts qualityRefreshSettle later.
func (r *qualityRefresh) noteOutput(now time.Time, out []byte, budget, fps int) {
	if !isExpensiveOutput(out, budget) {
		return
	}
	r.armed = true
	r.settleFrom = now
	r.remaining = qualityRefreshFrames(fps)
	r.extended = false
}

// start claims one re-submit when a refresh is due: armed, settled, and with
// budget left. The claim counts even if the encoder then fails the input, so
// a failing encoder cannot turn a static screen into a busy loop.
func (r *qualityRefresh) start(now time.Time) bool {
	if !r.armed || r.remaining <= 0 {
		return false
	}
	if now.Sub(r.settleFrom) < qualityRefreshSettle {
		return false
	}
	r.remaining--
	return true
}

// noteRefreshResult records the result of a refresh re-submit.
//   - An error or no output ends the refresh: an encoder that holds frames
//     must not be walked toward its stall flush by re-submits, and the idle
//     catch-up owns pushing held frames out.
//   - An IDR (a keyframe armed while idle, or the first output after a
//     flush) re-codes the whole picture at the current quantiser, which may
//     still be coarse; the budget is renewed once so the refresh continues
//     after it rather than ending on it.
func (r *qualityRefresh) noteRefreshResult(out []byte, err error, fps int) {
	if err != nil || len(out) == 0 {
		r.cancel()
		return
	}
	if !r.extended && h264ContainsIDR(out) {
		r.extended = true
		r.remaining = qualityRefreshFrames(fps)
	}
	if r.remaining <= 0 {
		r.armed = false
	}
}

// cancel forgets any pending or running refresh.
func (r *qualityRefresh) cancel() {
	*r = qualityRefresh{}
}

// idleRefeedKind is what an idle capture iteration re-submits, if anything.
type idleRefeedKind int

const (
	idleRefeedNone idleRefeedKind = iota
	// idleRefeedCatchUp pushes a held frame out (#11622).
	idleRefeedCatchUp
	// idleRefeedQuality is a quality refresh re-submit (#11639).
	idleRefeedQuality
)

// nextIdleRefeed decides, and claims from the matching budget, what an idle
// capture iteration re-submits. The catch-up comes first: while the newest
// screen change is still inside the encoder (or was lost to a flush), no
// refresh runs, so a refresh never competes with delivering the newest frame
// and never re-submits into an encoder that is not producing output.
func nextIdleRefeed(cu *idleCatchUp, qr *qualityRefresh, now time.Time) idleRefeedKind {
	if cu.startRefeed() {
		return idleRefeedCatchUp
	}
	if cu.owes() {
		return idleRefeedNone
	}
	if qr.start(now) {
		return idleRefeedQuality
	}
	return idleRefeedNone
}
