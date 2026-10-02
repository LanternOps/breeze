package agentapp

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// stubServiceStart replaces the take-back, the backoff timer, the durable
// report and the instance guard for prepareServiceStart.
func stubServiceStart(t *testing.T, reclaim func(call int) error) (calls *int, waits *[]time.Duration, reports *[]error, guarded *bool) {
	t.Helper()
	origReclaim, origAfter, origMarker, origGuard := reclaimConfigDirFn, configDirRetryAfterFn, writeInstanceGuardMarkerFn, acquireMainAgentGuardFn
	t.Cleanup(func() {
		reclaimConfigDirFn, configDirRetryAfterFn, writeInstanceGuardMarkerFn, acquireMainAgentGuardFn = origReclaim, origAfter, origMarker, origGuard
	})
	n, g := 0, false
	var w []time.Duration
	var r []error
	reclaimConfigDirFn = func(forEnroll bool) error {
		n++
		if forEnroll {
			t.Error("service start took the folder back for an enrollment")
		}
		return reclaim(n)
	}
	configDirRetryAfterFn = func(d time.Duration) <-chan time.Time {
		w = append(w, d)
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
	writeInstanceGuardMarkerFn = func(_ ProcessStartup, err error) { r = append(r, err) }
	acquireMainAgentGuardFn = func(ProcessStartup) (mainAgentGuard, error) {
		if n == 0 {
			t.Error("the instance guard was taken before the config folder")
		}
		g = true
		return nopGuard{}, nil
	}
	return &n, &w, &r, &g
}

// TestServiceStartKeepsRetryingTheConfigFolder: when the config folder
// cannot be taken back yet (a file in it held open, or an owner that cannot
// be checked while the domain is unreachable), the service does not exit: it
// tells the service manager it is running, records why it is waiting, and
// retries with a growing, capped delay until the take-back succeeds; then it
// takes the instance guard and starts.
func TestServiceStartKeepsRetryingTheConfigFolder(t *testing.T) {
	held := fmt.Errorf("%w: a file in it is held open", config.ErrConfigDirUntrusted)
	calls, waits, reports, guarded := stubServiceStart(t, func(call int) error {
		if call <= 8 {
			return held
		}
		return nil
	})
	running := 0
	guard, code, ok := prepareServiceStart(ProcessStartup{}, make(chan struct{}), func() { running++ })
	if !ok || guard == nil || code != 0 {
		t.Fatalf("prepareServiceStart = %v, %d, %v; want started", guard, code, ok)
	}
	if *calls != 9 || !*guarded {
		t.Errorf("take-back calls = %d guarded = %v; want 9 and the guard taken after", *calls, *guarded)
	}
	if running != 1 {
		t.Errorf("reported running %d times, want once, before the first wait", running)
	}
	if len(*reports) != 1 || !errors.Is((*reports)[0], config.ErrConfigDirUntrusted) {
		t.Errorf("durable reports = %v; want one, for the first failure (the same reason is not repeated)", *reports)
	}
	if len(*waits) != 8 {
		t.Fatalf("waits = %v", *waits)
	}
	for i := 1; i < len(*waits); i++ {
		if (*waits)[i] < (*waits)[i-1] {
			t.Errorf("delay shrank: %v", *waits)
		}
	}
	if last := (*waits)[len(*waits)-1]; last != configDirRetryMaxDelay {
		t.Errorf("last delay %v, want the cap %v", last, configDirRetryMaxDelay)
	}
}

// TestServiceStartTakesTheFolderBackOnceWhenItCan: the usual start does not
// report running early or wait.
func TestServiceStartTakesTheFolderBackOnceWhenItCan(t *testing.T) {
	calls, waits, reports, guarded := stubServiceStart(t, func(int) error { return nil })
	running := 0
	if _, _, ok := prepareServiceStart(ProcessStartup{}, make(chan struct{}), func() { running++ }); !ok {
		t.Fatal("not started")
	}
	if *calls != 1 || len(*waits) != 0 || len(*reports) != 0 || running != 0 || !*guarded {
		t.Errorf("calls=%d waits=%v reports=%v running=%d guarded=%v", *calls, *waits, *reports, running, *guarded)
	}
}

// TestServiceStartStopsWaitingWhenAskedToStop: a stop request while waiting
// ends the wait cleanly, without the guard or a start.
func TestServiceStartStopsWaitingWhenAskedToStop(t *testing.T) {
	_, _, _, guarded := stubServiceStart(t, func(int) error {
		return fmt.Errorf("%w: held open", config.ErrConfigDirUntrusted)
	})
	configDirRetryAfterFn = func(time.Duration) <-chan time.Time { return nil } // never fires
	stop := make(chan struct{})
	close(stop)
	guard, code, ok := prepareServiceStart(ProcessStartup{}, stop, func() {})
	if ok || guard != nil || code != 0 || *guarded {
		t.Errorf("prepareServiceStart = %v, %d, %v (guarded %v); want a clean stop", guard, code, ok, *guarded)
	}
}

// TestServiceStartReportsANewReason: a different reason on a later attempt
// is recorded again.
func TestServiceStartReportsANewReason(t *testing.T) {
	_, _, reports, _ := stubServiceStart(t, func(call int) error {
		switch call {
		case 1, 2:
			return fmt.Errorf("%w: held open", config.ErrConfigDirUntrusted)
		case 3:
			return fmt.Errorf("%w: owner could not be checked", config.ErrConfigDirUntrusted)
		}
		return nil
	})
	prepareServiceStart(ProcessStartup{}, make(chan struct{}), func() {})
	if len(*reports) != 2 {
		t.Errorf("reports = %v, want one per distinct reason", *reports)
	}
}
