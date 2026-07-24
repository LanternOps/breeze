package watchdog

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeClock is a manually advanced clock used to test time-based behavior.
type fakeClock struct{ now time.Time }

func (f *fakeClock) Now() time.Time         { return f.now }
func (f *fakeClock) Advance(d time.Duration) { f.now = f.now.Add(d) }

// noopServiceController returns success for every call — used when the test
// is about counting/history, not about the OS escalation steps. It mirrors the
// escalation ladder of the real unix controllers so the counters stay
// meaningful.
type noopServiceController struct{ restarts, kills, starts int }

func (n *noopServiceController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	result := RecoveryResult{
		Intent:      req.Intent,
		ActionTaken: true,
		Disposition: RecoveryDispositionVerifyHeartbeat,
	}
	switch {
	case req.Intent == RecoveryIntentEnsureStart:
		result.Action = RecoveryActionStart
		n.starts++
	case req.Intent == RecoveryIntentRestart, attempt <= 1:
		result.Action = RecoveryActionGraceful
		n.restarts++
	case attempt == 2:
		result.Action = RecoveryActionForced
		n.kills++
		n.starts++
	default:
		result.Action = RecoveryActionStart
		n.starts++
	}
	return result, nil
}

// fakeStructuredController returns a canned structured result/error and
// records the attempt number it was dispatched with.
type fakeStructuredController struct {
	result RecoveryResult
	err    error
	calls  []int
}

func (f *fakeStructuredController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	f.calls = append(f.calls, attempt)
	result := f.result
	result.StateFilePID = req.StateFilePID
	return result, f.err
}

func newTestRecovery(t *testing.T, clk Clock, svc serviceController) *RecoveryManager {
	t.Helper()
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	return r
}

func TestObservationOnlyRecoveryDoesNotConsumeAttempt(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)}
	svc := &fakeStructuredController{result: RecoveryResult{Action: RecoveryActionObserve, ActionTaken: false}}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	result, err := r.Attempt(RecoveryRequest{StateFilePID: 44})
	if err != nil || result.ActionTaken || r.Attempts() != 0 || r.Count24h() != 0 {
		t.Fatalf("result=%+v err=%v attempts=%d history=%d", result, err, r.Attempts(), r.Count24h())
	}
}

func TestFailedSideEffectConsumesAttempt(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)}
	svc := &fakeStructuredController{
		result: RecoveryResult{Action: RecoveryActionGraceful, ActionTaken: true, Phase: "wait_stopped"},
		err:    &RecoveryError{Class: RecoveryFailureStopTimeout, Phase: "wait_stopped"},
	}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	_, _ = r.Attempt(RecoveryRequest{StateFilePID: 44})
	if r.Attempts() != 1 || r.Count24h() != 1 {
		t.Fatalf("attempts=%d history=%d, want 1 and 1", r.Attempts(), r.Count24h())
	}
}

func TestStructuredResultPropagatesSCMPIDs(t *testing.T) {
	svc := &fakeStructuredController{result: RecoveryResult{OldPID: 100, NewPID: 200, Disposition: RecoveryDispositionVerifyHeartbeat, ActionTaken: true}}
	r := newRecoveryManagerWithDeps(3, 0, svc, &fakeClock{now: time.Now()})
	got, err := r.Attempt(RecoveryRequest{StateFilePID: 50})
	if err != nil || got.StateFilePID != 50 || got.OldPID != 100 || got.NewPID != 200 {
		t.Fatalf("result=%+v err=%v", got, err)
	}
}

func TestTerminalIdentityFailureExhaustsRecoveryWithoutRestartHistory(t *testing.T) {
	clk := &fakeClock{now: time.Now()}
	svc := &fakeStructuredController{
		result: RecoveryResult{Action: RecoveryActionForced, Disposition: RecoveryDispositionFailover},
		err:    &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_image"},
	}
	r := newRecoveryManagerWithDeps(3, time.Minute, svc, clk)
	_, _ = r.Attempt(RecoveryRequest{Intent: RecoveryIntentUnhealthy})
	clk.now = clk.now.Add(2 * time.Minute) // cooldown must not clear terminal exhaustion
	if r.CanAttempt() || r.Count24h() != 0 {
		t.Fatalf("canAttempt=%v history=%d, want false and 0", r.CanAttempt(), r.Count24h())
	}
	r.Reset()
	if !r.CanAttempt() {
		t.Fatal("explicit reset did not clear terminal exhaustion")
	}
}

// TestRecoveryRequestIntentDefaultsToUnhealthy pins the source-compatibility
// normalization at the RecoveryManager boundary.
func TestRecoveryRequestIntentDefaultsToUnhealthy(t *testing.T) {
	svc := &fakeStructuredController{result: RecoveryResult{ActionTaken: true}}
	r := newRecoveryManagerWithDeps(3, 0, svc, &fakeClock{now: time.Now()})
	got, err := r.Attempt(RecoveryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Intent != RecoveryIntentUnhealthy {
		t.Fatalf("intent=%q, want %q", got.Intent, RecoveryIntentUnhealthy)
	}
	if got.Disposition != RecoveryDispositionNone {
		t.Fatalf("disposition=%q, want %q", got.Disposition, RecoveryDispositionNone)
	}
}

// TestEscalationLadderDispatchesNextAttemptNumber proves the controller is
// handed the 1-based attempt number it is about to perform.
func TestEscalationLadderDispatchesNextAttemptNumber(t *testing.T) {
	svc := &fakeStructuredController{result: RecoveryResult{ActionTaken: true}}
	r := newRecoveryManagerWithDeps(3, time.Hour, svc, &fakeClock{now: time.Now()})
	for i := 0; i < 3; i++ {
		if _, err := r.Attempt(RecoveryRequest{Intent: RecoveryIntentUnhealthy}); err != nil {
			t.Fatal(err)
		}
	}
	want := []int{1, 2, 3}
	if len(svc.calls) != len(want) {
		t.Fatalf("calls=%v, want %v", svc.calls, want)
	}
	for i, w := range want {
		if svc.calls[i] != w {
			t.Fatalf("calls=%v, want %v", svc.calls, want)
		}
	}
}

func TestCount24hEmpty(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})
	if got := r.Count24h(); got != 0 {
		t.Fatalf("Count24h on empty: want 0, got %d", got)
	}
	if !r.LastRestartAt().IsZero() {
		t.Fatalf("LastRestartAt on empty: want zero time, got %v", r.LastRestartAt())
	}
}

func TestCount24hWithinWindow(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// Three restart attempts spaced 1h apart, all within the 24h window.
	for i := 0; i < 3; i++ {
		result, err := r.Attempt(RecoveryRequest{StateFilePID: 1234})
		if err != nil || !result.ActionTaken {
			t.Fatalf("attempt %d: result=%+v err=%v", i, result, err)
		}
		clk.Advance(time.Hour)
	}
	if got := r.Count24h(); got != 3 {
		t.Fatalf("Count24h within window: want 3, got %d", got)
	}
}

func TestCount24hPurgesOld(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// First attempt at t0.
	if _, err := r.Attempt(RecoveryRequest{StateFilePID: 1}); err != nil {
		t.Fatal(err)
	}
	// Advance 25h — first entry is now outside the window.
	clk.Advance(25 * time.Hour)
	// Reset per-window attempts so we can attempt again (we don't care about
	// the per-window cooldown for this test, only the 24h history).
	r.Reset()
	if _, err := r.Attempt(RecoveryRequest{StateFilePID: 2}); err != nil {
		t.Fatal(err)
	}
	if got := r.Count24h(); got != 1 {
		t.Fatalf("Count24h after purge: want 1, got %d", got)
	}
}

func TestCount24hBoundedByCap(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// Push 60 attempts inside the window; expect history capped at 50.
	for i := 0; i < 60; i++ {
		r.Reset() // bypass per-window cooldown for this test
		if _, err := r.Attempt(RecoveryRequest{StateFilePID: 1}); err != nil {
			t.Fatal(err)
		}
		clk.Advance(time.Minute)
	}
	if got := len(r.restartHistory); got != restartHistoryCap {
		t.Fatalf("restartHistory length: want %d (cap), got %d", restartHistoryCap, got)
	}
	if got := r.Count24h(); got != restartHistoryCap {
		t.Fatalf("Count24h with cap: want %d, got %d", restartHistoryCap, got)
	}
}

func TestLastRestartAtMatchesClock(t *testing.T) {
	t0 := time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)
	clk := &fakeClock{now: t0}
	r := newTestRecovery(t, clk, &noopServiceController{})

	if _, err := r.Attempt(RecoveryRequest{StateFilePID: 1}); err != nil {
		t.Fatal(err)
	}
	if got := r.LastRestartAt(); !got.Equal(t0) {
		t.Fatalf("LastRestartAt: want %v, got %v", t0, got)
	}
}

func TestHistoryRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "watchdog-restart-history.json")

	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r1 := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r1.SetHistoryPath(path)

	// Two attempts.
	r1.Attempt(RecoveryRequest{StateFilePID: 1})
	clk.Advance(time.Hour)
	r1.Reset()
	r1.Attempt(RecoveryRequest{StateFilePID: 2})

	// New manager points at the same file; advance not needed (clock starts at same value).
	r2 := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r2.SetHistoryPath(path)
	if got := r2.Count24h(); got != 2 {
		t.Fatalf("round-trip Count24h: want 2, got %d", got)
	}
}

func TestHistoryCorruptFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "watchdog-restart-history.json")
	if err := os.WriteFile(path, []byte("not json {{{"), 0o600); err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r.SetHistoryPath(path)
	if got := r.Count24h(); got != 0 {
		t.Fatalf("corrupt-file Count24h: want 0, got %d", got)
	}
}

func TestHistoryMissingFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r.SetHistoryPath(path)
	if got := r.Count24h(); got != 0 {
		t.Fatalf("missing-file Count24h: want 0, got %d", got)
	}
}

// BestEffortEnsureStart runs at recovery exhaustion, right before FAILOVER:
// it must dispatch an ensure-start WITHOUT consuming budget, history, or
// being blocked by the exhausted/terminal state — entering FAILOVER with the
// agent service stopped is permanent (#2763).
func TestBestEffortEnsureStartConsumesNoBudget(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)}
	svc := &noopServiceController{}
	r := newTestRecovery(t, clk, svc)

	// Exhaust the budget with real attempts.
	for i := 0; i < 3; i++ {
		if _, err := r.Attempt(RecoveryRequest{}); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if r.CanAttempt() {
		t.Fatal("precondition: budget should be exhausted")
	}
	attemptsBefore, count24hBefore := r.Attempts(), r.Count24h()

	result, err := r.BestEffortEnsureStart(context.Background())
	if err != nil {
		t.Fatalf("BestEffortEnsureStart: %v", err)
	}
	if result.Intent != RecoveryIntentEnsureStart {
		t.Fatalf("intent = %q, want %q", result.Intent, RecoveryIntentEnsureStart)
	}
	if svc.starts == 0 {
		t.Fatal("expected an ensure-start dispatch to the controller")
	}
	if r.Attempts() != attemptsBefore || r.Count24h() != count24hBefore {
		t.Fatalf("budget consumed: attempts %d->%d count24h %d->%d",
			attemptsBefore, r.Attempts(), count24hBefore, r.Count24h())
	}
}

// Even a terminal-exhausted manager (identity uncertainty latch) must still
// dispatch the best-effort start — the latch protects against forced kills of
// unidentified processes, and ensure-start kills nothing.
func TestBestEffortEnsureStartWorksWhenTerminalExhausted(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)}
	svc := &fakeStructuredController{result: RecoveryResult{Action: RecoveryActionStart, ActionTaken: true, Disposition: RecoveryDispositionFailover}}
	r := newTestRecovery(t, clk, svc)
	if _, err := r.Attempt(RecoveryRequest{}); err != nil {
		t.Fatalf("attempt: %v", err)
	}
	if r.CanAttempt() {
		t.Fatal("precondition: terminal exhaustion expected")
	}
	callsBefore := len(svc.calls)
	if _, err := r.BestEffortEnsureStart(context.Background()); err != nil {
		t.Fatalf("BestEffortEnsureStart: %v", err)
	}
	if len(svc.calls) != callsBefore+1 {
		t.Fatal("ensure-start was not dispatched")
	}
}
