package desktop

import "time"

// framePacer throttles delivered frames to the target rate using an absolute
// schedule instead of per-iteration sleep padding.
//
// The old capture-loop tail — time.Sleep(frameDuration - elapsed) after every
// sent frame — systematically undershot the target fps on the DXGI path: the
// pad runs *before* the next AcquireNextFrame block, so each iteration pays
// the pad plus the wait for the next present, and any sleep overshoot
// (Windows timer quantization) accumulates instead of being repaid. A 60fps
// target on a 60Hz display delivered ~48fps.
//
// With an absolute schedule a frame delivered late (oversleep, slow encode,
// vsync phase) makes the next wait negative, so the deficit is repaid rather
// than compounded — the long-run rate converges on min(display rate, target
// fps). In steady state on a display at or below the target rate next()
// returns 0 and AcquireNextFrame's own blocking is the pacing; the sleep only
// engages when frames are produced faster than the target (e.g. a 144Hz
// display with a 60fps target, or repaint-nudged bursts).
//
// Not safe for concurrent use; owned by a single capture loop.
type framePacer struct {
	nextDue time.Time
}

// next records a frame delivered at now and returns how long the caller
// should sleep before capturing the next one (0 = don't sleep). period is
// the current target frame duration and may change between calls.
func (p *framePacer) next(now time.Time, period time.Duration) time.Duration {
	if p.nextDue.IsZero() {
		p.nextDue = now.Add(period)
		return 0
	}
	wait := p.nextDue.Sub(now)
	if wait <= 0 {
		if wait < -period {
			// More than a full period behind (idle gap, stall, fps change):
			// resync to now so the backlog doesn't turn into a catch-up burst.
			p.nextDue = now.Add(period)
		} else {
			// Slightly behind: anchor to the schedule so the deficit is
			// repaid by a shorter wait on the following frames.
			p.nextDue = p.nextDue.Add(period)
		}
		return 0
	}
	p.nextDue = p.nextDue.Add(period)
	return wait
}
