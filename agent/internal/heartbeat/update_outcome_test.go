package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
)

// Issue #9751: Windows Server 2016 agents retried the 0.122.1 → 0.124.0
// self-update thousands of times with nothing at warn or above in agent_logs.
// On Windows the swap runs in a detached PowerShell helper after the agent
// "succeeds", so a swap that never takes leaves the old binary restarting
// with no error. Each attempt costs a process restart, so the in-memory
// backoffs reset every time. The fix detects the failed swap at startup
// (the update marker names a version other than the running one), ships the
// helper's captured exception at error level, and latches the version on disk.

type outcomeFixture struct {
	h      *Heartbeat
	clk    *testClock
	logDir string
}

func newOutcomeFixture(t *testing.T, running string) *outcomeFixture {
	t.Helper()
	clk := &testClock{t: time.Date(2026, 10, 20, 2, 41, 0, 0, time.UTC)}
	logDir := t.TempDir()
	return &outcomeFixture{
		h: &Heartbeat{
			agentVersion:       running,
			updateLatch:        &updater.FailureLatch{Path: filepath.Join(t.TempDir(), "latch.json"), Now: clk.now},
			updateHelperLogDir: logDir,
		},
		clk:    clk,
		logDir: logDir,
	}
}

// restart models the agent process restarting: a fresh Heartbeat that shares
// only what is on disk.
func (f *outcomeFixture) restart() {
	f.h = &Heartbeat{
		agentVersion:       f.h.agentVersion,
		updateLatch:        &updater.FailureLatch{Path: f.h.updateLatch.Path, Now: f.clk.now},
		updateHelperLogDir: f.logDir,
	}
}

const helperFailureLog = "\ufeffBreeze update-helper failure at 2026-10-20T02:41:09.0000000+00:00\r\n" +
	"operation:   Copy-Item -Path 'C:\\Windows\\TEMP\\breeze-agent-new.exe' -Destination 'C:\\Program Files\\Breeze\\breeze-agent.exe' -Force\r\n" +
	"exception: The process cannot access the file 'C:\\Program Files\\Breeze\\breeze-agent.exe' because it is being used by another process.\r\n" +
	"stackTrace:    at System.IO.__Error.WinIOError(Int32 errorCode, String maybeFullPath)\r\n" +
	"scriptStackTrace: at <ScriptBlock>, C:\\Windows\\TEMP\\breeze-update-1.ps1: line 7\r\n"

func TestReconcileUpdateOutcome_FailedSwapLatchesAndCarriesTheHelperReason(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	markerAt := f.clk.t.Add(-10 * time.Second)
	logPath := filepath.Join(f.logDir, "breeze-update-failure-638650000000000000.log")
	if err := os.WriteFile(logPath, []byte(helperFailureLog), 0o600); err != nil {
		t.Fatal(err)
	}

	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: markerAt})

	st, ok := f.h.updateLatch.Load()
	if !ok {
		t.Fatal("a swap that did not take effect must latch the target version")
	}
	if st.Version != "0.124.0" || st.Failures != 1 {
		t.Fatalf("latch = %+v, want 0.124.0 with 1 failure", st)
	}
	if !strings.Contains(st.Reason, "being used by another process") {
		t.Fatalf("latch reason %q does not carry the helper's exception", st.Reason)
	}
	if !strings.Contains(st.Reason, "Copy-Item") {
		t.Fatalf("latch reason %q does not carry the failing operation", st.Reason)
	}
	if strings.ContainsAny(st.Reason, "\r\n\ufeff") {
		t.Fatalf("latch reason %q must be a single sanitized line", st.Reason)
	}
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatal("the consumed helper failure log must be removed so it is not reported twice")
	}
	if !f.h.upgradeDeferredByFailureLatch("0.124.0") {
		t.Fatal("the next offer of the failed version must be deferred")
	}
	if f.h.upgradeDeferredByFailureLatch("0.125.0") {
		t.Fatal("a different target version must be attempted immediately")
	}
}

func TestReconcileUpdateOutcome_NoHelperLogStillLatchesWithAFallbackReason(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	st, ok := f.h.updateLatch.Load()
	if !ok || st.Failures != 1 {
		t.Fatalf("latch = %+v (present %v), want 1 failure", st, ok)
	}
	if st.Reason != updateHelperNoLogReason {
		t.Fatalf("reason = %q, want the no-log fallback", st.Reason)
	}
}

// A failure log older than this attempt belongs to an earlier one and must
// not be blamed on it.
func TestReconcileUpdateOutcome_IgnoresHelperLogsOlderThanTheAttempt(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	stale := filepath.Join(f.logDir, "breeze-update-failure-1.log")
	if err := os.WriteFile(stale, []byte(helperFailureLog), 0o600); err != nil {
		t.Fatal(err)
	}
	old := f.clk.t.Add(-6 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	st, _ := f.h.updateLatch.Load()
	if st.Reason != updateHelperNoLogReason {
		t.Fatalf("reason = %q, want the no-log fallback (the only log predates the attempt)", st.Reason)
	}
}

func TestReconcileUpdateOutcome_SuccessfulSwapClearsTheLatch(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	f.h.agentVersion = "0.124.0" // the retry took
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	if st, ok := f.h.updateLatch.Load(); ok {
		t.Fatalf("latch %+v survived a successful update", st)
	}
}

func TestReconcileUpdateOutcome_EmptyMarkerIsANoOp(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	f.h.reconcileUpdateOutcome(updateMarker{})
	if st, ok := f.h.updateLatch.Load(); ok {
		t.Fatalf("an empty marker latched %+v", st)
	}
}

// The incident, replayed: three days of ~60 s heartbeats all offering
// 0.124.0, where every attempt restarts the process on the old binary. Before
// #9751 each heartbeat attempted (about 4,300 in 72 h). Now: attempts
// at 0, +1h, +3h, +7h, +15h, +31h, +55h → 7.
func TestUpdateFailureLatch_ReplayOfTheIncident(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	attempts := 0
	for beat := 0; beat < 72*60; beat++ {
		if !f.h.upgradeDeferredByFailureLatch("0.124.0") {
			attempts++
			// The attempt "succeeds" in-process, the helper swap fails, and
			// the old binary restarts and reads the marker.
			marker := updateMarker{Version: "0.124.0", WrittenAt: f.clk.t}
			f.restart()
			f.h.reconcileUpdateOutcome(marker)
		}
		f.clk.advance(time.Minute)
	}
	if attempts != 7 {
		t.Fatalf("expected 7 attempts over 72 h, got %d", attempts)
	}
}

func TestConsumeUpdateMarkerAt_ReturnsVersionAndRemovesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".update-restart")
	if _, ok := consumeUpdateMarkerAt(path); ok {
		t.Fatal("an absent marker must report not found")
	}
	if err := os.WriteFile(path, []byte(" 0.124.0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, ok := consumeUpdateMarkerAt(path)
	if !ok || m.Version != "0.124.0" || m.WrittenAt.IsZero() {
		t.Fatalf("got (%+v, %v), want version 0.124.0 with its write time", m, ok)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the marker must be removed once consumed")
	}
}

// The other path that stamps update_status and then gives up at Info level is
// the backup-busy deferral: a backup job that runs for days defers the agent
// update on every heartbeat with nothing at warn or above. The server cannot
// tell which path a stuck device is on, so both must be visible.
func TestBackupDeferral_EscalatesWhenItPersists(t *testing.T) {
	h := &Heartbeat{}
	t0 := time.Date(2026, 10, 20, 2, 41, 0, 0, time.UTC)
	steps := []struct {
		at   time.Duration
		ver  string
		want string
	}{
		{0, "0.124.0", "warn"},                          // a new episode is announced once
		{time.Minute, "0.124.0", "debug"},               // then quiet while it is plausibly a normal job
		{59 * time.Minute, "0.124.0", "debug"},          //
		{time.Hour, "0.124.0", "error"},                 // an hour in, it is a problem
		{2 * time.Hour, "0.124.0", "debug"},             // reported once, not every beat
		{25 * time.Hour, "0.124.0", "error"},            // and again a day later
		{25*time.Hour + time.Minute, "0.125.0", "warn"}, // a new target is a new episode
	}
	for _, s := range steps {
		if got := h.noteUpgradeDeferredByBackup(s.ver, t0.Add(s.at)); got != s.want {
			t.Fatalf("at +%s for %s: level %q, want %q", s.at, s.ver, got, s.want)
		}
	}
	h.clearUpgradeBackupDeferral()
	if got := h.noteUpgradeDeferredByBackup("0.125.0", t0.Add(26*time.Hour)); got != "warn" {
		t.Fatalf("after the deferral cleared, the next one is a new episode; got %q", got)
	}
}
