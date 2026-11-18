package desktop

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// No build tag: gdiCapturer.Capture is Windows-only, but what one capture
// attempt does to its bookkeeping (gdiCaptureBook.onCaptureResult) is pure Go
// and asserted here on every OS (#8434 review). Before the extraction,
// deleting the streak reset on a delivered frame left every test green.

func testFrame() *image.RGBA { return image.NewRGBA(image.Rect(0, 0, 2, 2)) }

func TestOnCaptureResultDeliveredFrameResetsTheRecycleStreak(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	busy := setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy))

	if deliver, retire := b.onCaptureResult(nil, busy, nil, t0); deliver || !retire {
		t.Fatalf("first ERROR_BUSY = (deliver %v, retire %v), want (false, true)", deliver, retire)
	}
	// Inside the backoff: a second ERROR_BUSY keeps the thread.
	if _, retire := b.onCaptureResult(nil, busy, nil, t0.Add(time.Millisecond)); retire {
		t.Fatal("retired the thread inside the recycle backoff")
	}
	if b.recycler.streak != 1 {
		t.Fatalf("streak = %d after one recycle, want 1", b.recycler.streak)
	}

	if deliver, retire := b.onCaptureResult(testFrame(), nil, nil, t0.Add(2*time.Millisecond)); !deliver || retire {
		t.Fatalf("delivered frame = (deliver %v, retire %v), want (true, false)", deliver, retire)
	}
	if b.recycler.streak != 0 {
		t.Fatalf("streak = %d after a delivered frame, want 0", b.recycler.streak)
	}
	if b.lastCaptureErr != nil || b.consecutiveCaptureFailures != 0 {
		t.Fatalf("a delivered frame kept the failure state (%v, %d)", b.lastCaptureErr, b.consecutiveCaptureFailures)
	}
	// The streak is over, so the next ERROR_BUSY recycles at once even though
	// it is well inside what the old streak's backoff would have been.
	if _, retire := b.onCaptureResult(nil, busy, nil, t0.Add(3*time.Millisecond)); !retire {
		t.Fatal("ERROR_BUSY right after a delivered frame did not retire the thread; the streak was not reset")
	}
}

func TestOnCaptureResultPanicRetiresTheThread(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	panicked := fmt.Errorf("%w: %v", errCaptureThreadPanicked, "boom")

	deliver, retire := b.onCaptureResult(nil, panicked, nil, t0)
	if deliver || !retire {
		t.Fatalf("panic = (deliver %v, retire %v), want (false, true)", deliver, retire)
	}
	if !errors.Is(b.lastCaptureErr, errCaptureThreadPanicked) {
		t.Fatalf("lastCaptureErr = %v, want the panic", b.lastCaptureErr)
	}
}

func TestOnCaptureResultOtherFailuresKeepTheThread(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	for name, capErr := range map[string]error{
		"access denied attach": setThreadDesktopError("Default", "Winlogon", syscall.Errno(errAccessDenied)),
		"BitBlt busy":          gdiCallError("BitBlt", syscall.Errno(errBusy)),
	} {
		if deliver, retire := b.onCaptureResult(nil, capErr, nil, t0); deliver || retire {
			t.Errorf("%s = (deliver %v, retire %v), want (false, false)", name, deliver, retire)
		}
		if b.lastCaptureErr != capErr {
			t.Errorf("%s: lastCaptureErr = %v, want the frame error", name, b.lastCaptureErr)
		}
	}
	// No error and no image is still a failure the technician can be told about.
	if deliver, _ := b.onCaptureResult(nil, nil, nil, t0); deliver {
		t.Fatal("delivered a nil image")
	}
	if b.lastCaptureErr == nil || !strings.Contains(b.lastCaptureErr.Error(), "no image") {
		t.Fatalf("lastCaptureErr = %v, want the no-image error", b.lastCaptureErr)
	}
}

func TestOnCaptureResultRecordsTheFollowIssue(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	cause := gdiCallError("OpenInputDesktop", syscall.Errno(errAccessDenied))

	if deliver, _ := b.onCaptureResult(testFrame(), nil, cause, t0); !deliver {
		t.Fatal("a frame with a follow issue must still be delivered")
	}
	w := b.captureWarning()
	if w == nil {
		t.Fatal("captureWarning is nil after a frame taken without confirming the input desktop")
	}
	if code, ok := win32ErrorCode(w); !ok || code != errAccessDenied {
		t.Fatalf("captureWarning code = %d, %v; want %d", code, ok, errAccessDenied)
	}
	if b.lastCaptureErr != nil {
		t.Fatalf("an unconfirmed frame set lastCaptureErr = %v; it is a warning, not a failure", b.lastCaptureErr)
	}

	b.onCaptureResult(testFrame(), nil, nil, t0.Add(time.Second))
	if w := b.captureWarning(); w != nil {
		t.Fatalf("captureWarning = %v after a confirmed frame, want nil", w)
	}
}

func TestGDICaptureBookResetClearsStreakAndWarning(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	b.onCaptureResult(nil, setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy)), nil, t0)
	b.onCaptureResult(testFrame(), nil, errors.New("input desktop name is unreadable"), t0)
	b.onCaptureResult(nil, setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy)), nil, t0)

	b.reset()
	if b.recycler.streak != 0 {
		t.Fatalf("streak = %d after reset, want 0", b.recycler.streak)
	}
	if w := b.captureWarning(); w != nil {
		t.Fatalf("captureWarning = %v after reset, want nil", w)
	}
}

// The periodic "Desktop WebRTC metrics" line reads CaptureWarning. It must not
// wait on the capture lock: a wedged BitBlt or SetThreadDesktop holds that
// lock, and silencing the metrics line would hide the one clue that capture
// is stuck (#8434 review). captureWarning is read with no lock while the
// capture path updates the book; run with -race.
func TestCaptureWarningIsReadWithoutTheCaptureLock(t *testing.T) {
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	cause := gdiCallError("OpenInputDesktop", syscall.Errno(errAccessDenied))

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 2000; i++ {
			var follow error
			if i%3 != 0 {
				follow = cause
			}
			b.onCaptureResult(testFrame(), nil, follow, t0.Add(time.Duration(i)*time.Millisecond))
		}
		b.reset()
	}()
	seen := false
	for {
		select {
		case <-done:
			if w := b.captureWarning(); w != nil {
				t.Fatalf("captureWarning = %v after reset, want nil", w)
			}
			if !seen {
				t.Log("reader never observed a warning; the race check still ran")
			}
			return
		default:
			if w := b.captureWarning(); w != nil {
				seen = true
				if !strings.Contains(w.Error(), "OpenInputDesktop") {
					t.Fatalf("captureWarning = %q, want the follow issue", w)
				}
			}
		}
	}
}

// The end of an unconfirmed-desktop streak is logged at Info, which the
// desktop helper does not ship by default; without ShipAlways, Agent Logs
// show the streak's Warn but never that it ended (#8434 review).
func TestUnconfirmedDesktopRecoveryLineShips(t *testing.T) {
	h := installRecordingLogger(t)
	var b gdiCaptureBook
	t0 := time.Unix(1_000_000, 0)
	b.onCaptureResult(testFrame(), nil, gdiCallError("OpenInputDesktop", syscall.Errno(errAccessDenied)), t0)
	b.onCaptureResult(testFrame(), nil, nil, t0.Add(time.Second))

	r, ok := h.find("GDI capture thread confirmed the input desktop again")
	if !ok {
		t.Fatal("no recovery line after an unconfirmed streak ended")
	}
	if v, ok := attrKeys(r)[logging.KeyShipAlways]; !ok || !v.Bool() {
		t.Fatalf("recovery line does not carry ShipAlways; attrs %v", attrKeys(r))
	}
}
