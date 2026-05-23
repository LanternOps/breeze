package watchdog

import (
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
// is about counting/history, not about the OS escalation steps.
type noopServiceController struct{ restarts, kills, starts int }

func (n *noopServiceController) RestartAgentService() error { n.restarts++; return nil }
func (n *noopServiceController) StartAgentService() error   { n.starts++; return nil }
func (n *noopServiceController) ForceKillProcess(int)       { n.kills++ }

func newTestRecovery(t *testing.T, clk Clock, svc serviceController) *RecoveryManager {
	t.Helper()
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	return r
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
		ok, err := r.Attempt(1234)
		if err != nil || !ok {
			t.Fatalf("attempt %d: ok=%v err=%v", i, ok, err)
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
	if _, err := r.Attempt(1); err != nil {
		t.Fatal(err)
	}
	// Advance 25h — first entry is now outside the window.
	clk.Advance(25 * time.Hour)
	// Reset per-window attempts so we can attempt again (we don't care about
	// the per-window cooldown for this test, only the 24h history).
	r.Reset()
	if _, err := r.Attempt(2); err != nil {
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
		if _, err := r.Attempt(1); err != nil {
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

	if _, err := r.Attempt(1); err != nil {
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
	r1.Attempt(1)
	clk.Advance(time.Hour)
	r1.Reset()
	r1.Attempt(2)

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
