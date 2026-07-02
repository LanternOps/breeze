package desktop

import (
	"testing"
	"time"
)

const testPeriod = 16667 * time.Microsecond // 60fps

// TestFramePacer_FirstFrameNoWait pins that the first delivered frame never
// sleeps — the pacer has no schedule to compare against yet.
func TestFramePacer_FirstFrameNoWait(t *testing.T) {
	var p framePacer
	if wait := p.next(time.Unix(0, 0), testPeriod); wait != 0 {
		t.Fatalf("first frame wait = %v, want 0", wait)
	}
}

// TestFramePacer_DisplayPacedSteadyState pins the headline behavior of
// Change #7: when the display delivers frames at exactly the target rate
// (AcquireNextFrame blocking is the pacing), the pacer never sleeps. The old
// relative pad slept ~frameDuration here and stacked with the present-wait,
// capping delivered fps at ~48 on a 60Hz/60fps rig.
func TestFramePacer_DisplayPacedSteadyState(t *testing.T) {
	var p framePacer
	now := time.Unix(0, 0)
	for i := 0; i < 100; i++ {
		if wait := p.next(now, testPeriod); wait != 0 {
			t.Fatalf("frame %d: wait = %v, want 0 (display-paced steady state must not sleep)", i, wait)
		}
		now = now.Add(testPeriod)
	}
}

// TestFramePacer_ThrottlesFastProducer pins that a producer faster than the
// target (144Hz display, 60fps target) is throttled to the target rate on
// average: simulate a caller that sleeps exactly the returned wait, and
// assert N frames span (N-1)*period.
func TestFramePacer_ThrottlesFastProducer(t *testing.T) {
	var p framePacer
	const produceTime = 3 * time.Millisecond // capture+encode, well under period
	now := time.Unix(0, 0)
	start := now
	const frames = 60
	for i := 0; i < frames; i++ {
		now = now.Add(produceTime)
		now = now.Add(p.next(now, testPeriod)) // caller sleeps the returned wait
	}
	elapsed := now.Sub(start)
	want := time.Duration(frames-1) * testPeriod
	if elapsed < want {
		t.Fatalf("fast producer not throttled: %d frames in %v, want >= %v", frames, elapsed, want)
	}
	if elapsed > want+2*testPeriod {
		t.Fatalf("fast producer over-throttled: %d frames in %v, want ~%v", frames, elapsed, want)
	}
}

// TestFramePacer_OversleepRepaid pins the self-compensation property: a frame
// delivered late by less than a period (sleep quantization overshoot) shrinks
// the next wait instead of pushing the whole schedule back — so quantized
// sleeps cannot accumulate into a lower delivered fps.
func TestFramePacer_OversleepRepaid(t *testing.T) {
	var p framePacer
	now := time.Unix(0, 0)
	p.next(now, testPeriod) // due = t0 + period

	// Frame 2 arrives 10ms late (period + 10ms after frame 1).
	late := 10 * time.Millisecond
	now = now.Add(testPeriod + late)
	if wait := p.next(now, testPeriod); wait != 0 {
		t.Fatalf("late frame wait = %v, want 0", wait)
	}

	// Frame 3 is produced immediately: wait must be period - late (repayment),
	// not a full period.
	if wait := p.next(now, testPeriod); wait != testPeriod-late {
		t.Fatalf("post-oversleep wait = %v, want %v (deficit repaid)", wait, testPeriod-late)
	}
}

// TestFramePacer_IdleGapResyncsWithoutBurst pins that after a long idle gap
// (many periods with no sent frames) the schedule resyncs: the resume frame
// doesn't sleep, and the frame after it is throttled normally — no burst of
// zero-wait catch-up frames.
func TestFramePacer_IdleGapResyncsWithoutBurst(t *testing.T) {
	var p framePacer
	now := time.Unix(0, 0)
	p.next(now, testPeriod)

	// 5 seconds idle, then a frame.
	now = now.Add(5 * time.Second)
	if wait := p.next(now, testPeriod); wait != 0 {
		t.Fatalf("resume frame wait = %v, want 0", wait)
	}

	// Next frame produced 1ms later must wait ~a full period (no burst).
	now = now.Add(time.Millisecond)
	if wait := p.next(now, testPeriod); wait != testPeriod-time.Millisecond {
		t.Fatalf("post-resume wait = %v, want %v (schedule resynced, no catch-up burst)", wait, testPeriod-time.Millisecond)
	}
}

// TestFramePacer_PeriodChangeAdapts pins that a mid-session fps change
// (adaptive controller, secure-desktop clamp) takes effect on the next frame
// without a stall or burst.
func TestFramePacer_PeriodChangeAdapts(t *testing.T) {
	var p framePacer
	now := time.Unix(0, 0)
	p.next(now, testPeriod)

	// Drop to 30fps: frame produced immediately should wait toward the OLD
	// due time first (schedule continuity), then subsequent spacing is the
	// new period.
	slow := 2 * testPeriod
	wait := p.next(now, slow)
	if wait != testPeriod {
		t.Fatalf("first wait after fps change = %v, want %v", wait, testPeriod)
	}
	now = now.Add(wait)
	wait = p.next(now, slow)
	if wait != slow {
		t.Fatalf("steady wait at new period = %v, want %v", wait, slow)
	}
}
