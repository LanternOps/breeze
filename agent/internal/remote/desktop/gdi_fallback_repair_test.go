package desktop

import (
	"syscall"
	"testing"
	"time"
)

// No build tag: dxgiCapturer.captureFromGDIFallbackLocked is Windows-only,
// but its repair decision (gdiFallbackRepairDue) and what the replacement
// inherits (gdiRepairCarry) are pure Go, and the loop below is that function
// and gdiCapturer.Capture with the Win32 calls replaced by an ERROR_BUSY that
// never clears.

// fallbackSim is a GDI fallback as captureFromGDIFallbackLocked sees it: the
// production bookkeeping plus whether its capture thread is running.
type fallbackSim struct {
	book    *gdiCaptureBook
	running bool
}

// Persistent ERROR_BUSY with the fallback recreated by the no-frame repair:
// every GDI capturer is DXGI's gdiFallback, and the repair used to replace it
// every 500ms with a fresh recycler, so the backoff restarted at 0/150/450ms
// each time (about 8 OS threads a second) and the recycle Warn fired about
// twice a second (#8434 review). Thread starts must stay inside the band
// TestCaptureThreadRecyclerBacksOff sets for a single capturer.
func TestGDIFallbackRepairKeepsRecycleBackoff(t *testing.T) {
	h := installRecordingLogger(t)
	busy := setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy))
	t0 := time.Unix(1_000_000, 0)

	fb := fallbackSim{book: &gdiCaptureBook{}}
	threadStarts, repairs := 0, 0
	noFrames := 0
	var lastRepair time.Time
	for now := t0; now.Before(t0.Add(5 * time.Minute)); now = now.Add(10 * time.Millisecond) {
		// gdiCapturer.Capture: start a thread if none, attempt, retire on request.
		if !fb.running {
			fb.running = true
			threadStarts++
		}
		if deliver, retire := fb.book.onCaptureResult(nil, busy, nil, now); deliver {
			t.Fatal("delivered a frame under persistent ERROR_BUSY")
		} else if retire {
			fb.running = false
		}

		// captureFromGDIFallbackLocked: count the frameless sample, maybe repair.
		noFrames++
		carry := fb.book.repairCarry()
		if gdiFallbackRepairDue(noFrames, lastRepair, carry, now) {
			lastRepair = now
			repairs++
			fb = fallbackSim{book: &gdiCaptureBook{}} // the replacement starts its thread on its first capture
			fb.book.adoptRepairCarry(carry)
		}
	}

	recycles := threadStarts - 1
	if recycles > 20 {
		t.Fatalf("%d capture threads replaced in 5 minutes of persistent ERROR_BUSY (%d by the fallback repair); the repair defeats the recycle backoff", recycles, repairs)
	}
	if recycles < 9 {
		t.Fatalf("%d capture threads replaced in 5 minutes; capture stopped retrying altogether", recycles)
	}
	warns := 0
	for _, r := range h.records {
		if r.Message == "Retiring the GDI capture thread; the next frame starts a new thread" {
			warns++
		}
	}
	t.Logf("5 minutes of persistent ERROR_BUSY: %d thread replacements (%d by repair), %d recycle Warns", recycles, repairs, warns)
	if warns > 12 {
		t.Fatalf("%d recycle Warns in 5 minutes; the throttle does not survive the repair", warns)
	}
}

func TestGDIFallbackRepairDue(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	var idle captureThreadRecycler
	if gdiFallbackRepairDue(gdiFallbackRepairNoFrames-1, time.Time{}, gdiRepairCarry{recycler: idle}, t0) {
		t.Error("repaired before the no-frame threshold")
	}
	if !gdiFallbackRepairDue(gdiFallbackRepairNoFrames, time.Time{}, gdiRepairCarry{recycler: idle}, t0) {
		t.Error("a fallback with no recycle streak was not repaired at the threshold")
	}
	if gdiFallbackRepairDue(100, t0.Add(-gdiFallbackRepairInterval/2), gdiRepairCarry{recycler: idle}, t0) {
		t.Error("repaired inside the repair interval")
	}

	// A fallback inside its recycle backoff is left alone; once the backoff
	// has elapsed the repair may run, so a recovered desktop never waits
	// longer than the current backoff.
	backingOff := captureThreadRecycler{streak: 3, last: t0}
	if gdiFallbackRepairDue(100, time.Time{}, gdiRepairCarry{recycler: backingOff}, t0.Add(captureThreadRecycleDelay(3)-time.Millisecond)) {
		t.Error("repaired a fallback inside its recycle backoff")
	}
	if !gdiFallbackRepairDue(100, time.Time{}, gdiRepairCarry{recycler: backingOff}, t0.Add(captureThreadRecycleDelay(3))) {
		t.Error("did not repair once the fallback's recycle backoff had elapsed")
	}
}

// The replacement keeps the swallowed capture error (#5284) and the recycle
// streak, next-allowed time and Warn throttle.
func TestGDIRepairCarry(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	busy := setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy))
	old := &gdiCaptureBook{}
	old.onCaptureResult(nil, busy, nil, t0)
	old.onCaptureResult(nil, busy, nil, t0.Add(captureThreadRecycleMinInterval))

	replacement := &gdiCaptureBook{}
	replacement.adoptRepairCarry(old.repairCarry())
	if replacement.lastCaptureErr != old.lastCaptureErr {
		t.Errorf("lastCaptureErr = %v, want %v", replacement.lastCaptureErr, old.lastCaptureErr)
	}
	if replacement.recycler != old.recycler {
		t.Errorf("recycler = %+v, want %+v", replacement.recycler, old.recycler)
	}
	// The carried streak still backs off: no recycle inside its delay.
	if _, retire := replacement.onCaptureResult(nil, busy, nil, t0.Add(captureThreadRecycleMinInterval+time.Millisecond)); retire {
		t.Error("the replacement recycled inside the carried backoff")
	}
}
