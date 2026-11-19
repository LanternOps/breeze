package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
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
	logPath := writeHelperLog(t, f.logDir, "638650000000000000", helperFailureLog, markerAt.Add(5*time.Second))

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
	if _, err := os.Stat(stale); err != nil {
		t.Fatalf("a log that predates the attempt must be left alone, stat err %v", err)
	}
}

// writeHelperLog writes a helper failure log named like the script's, with an
// explicit mtime so tests never depend on the real clock.
func writeHelperLog(t *testing.T, dir, stamp, body string, mod time.Time) string {
	t.Helper()
	p := filepath.Join(dir, updater.UpdateHelperFailureLogPrefix+stamp+".log")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadUpdateHelperFailure_SelectionAndParsing(t *testing.T) {
	since := time.Date(2026, 10, 20, 2, 40, 0, 0, time.UTC)
	t.Run("newest fresh log wins and every fresh log is removed", func(t *testing.T) {
		dir := t.TempDir()
		older := writeHelperLog(t, dir, "1", "exception: older failure\r\n", since.Add(time.Second))
		newer := writeHelperLog(t, dir, "2", "exception: newer failure\r\n", since.Add(2*time.Second))
		got := readUpdateHelperFailure(dir, since)
		if got != "update helper failed: newer failure" {
			t.Fatalf("got %q, want the newest log's exception", got)
		}
		for _, p := range []string{older, newer} {
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatalf("%s should have been removed", filepath.Base(p))
			}
		}
	})
	t.Run("later block in the same file wins", func(t *testing.T) {
		dir := t.TempDir()
		writeHelperLog(t, dir, "1", "operation: first\nexception: first\nexception: second\noperation: second\n", since)
		if got := readUpdateHelperFailure(dir, since); got != "update helper failed: second (operation: second)" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("operation only", func(t *testing.T) {
		dir := t.TempDir()
		writeHelperLog(t, dir, "1", "operation: Stop-Service\n", since)
		if got := readUpdateHelperFailure(dir, since); got != "update helper failed during: Stop-Service" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("a log with nothing usable says so instead of claiming there was none", func(t *testing.T) {
		dir := t.TempDir()
		p := writeHelperLog(t, dir, "1", "garbage\nmore garbage\n", since)
		if got := readUpdateHelperFailure(dir, since); got != updateHelperUnparseableReason {
			t.Fatalf("got %q, want the unparseable reason", got)
		}
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("a considered log is removed even when it could not be parsed")
		}
	})
	t.Run("a directory matching the pattern is neither read nor removed", func(t *testing.T) {
		dir := t.TempDir()
		d := filepath.Join(dir, updater.UpdateHelperFailureLogPrefix+"dir.log")
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
		if got := readUpdateHelperFailure(dir, since.Add(-time.Hour)); got != "" {
			t.Fatalf("got %q, want no reason from a directory", got)
		}
		if _, err := os.Stat(d); err != nil {
			t.Fatalf("directory must be left alone, stat err %v", err)
		}
	})
	t.Run("control characters and overlong fields are bounded", func(t *testing.T) {
		dir := t.TempDir()
		writeHelperLog(t, dir, "1", "exception: a\x1b[31mb\tc "+strings.Repeat("x", 1000)+"\n", since)
		got := readUpdateHelperFailure(dir, since)
		if strings.ContainsAny(got, "\x1b\t") {
			t.Fatalf("got %q, control characters must be dropped", got)
		}
		if len(got) > len("update helper failed: ")+updateHelperFieldMax+len("…") {
			t.Fatalf("got %d bytes, field must be bounded", len(got))
		}
	})
}

// A helper log written just before the marker's timestamp (clock skew,
// timestamp granularity) still belongs to the attempt.
func TestReconcileUpdateOutcome_HelperLogWithinSlackIsUsed(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	markerAt := f.clk.t
	writeHelperLog(t, f.logDir, "1", "exception: just before the marker\n", markerAt.Add(-30*time.Second))
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: markerAt})
	st, _ := f.h.updateLatch.Load()
	if st.Reason != "update helper failed: just before the marker" {
		t.Fatalf("reason = %q, want the log inside the slack window", st.Reason)
	}
}

// If the latch cannot be written, reconcile must not panic, and nothing is
// held back (the error is logged; the next heartbeat retries).
func TestReconcileUpdateOutcome_LatchWriteFailureDoesNotBlockOrPanic(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	blocker := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	f.h.updateLatch.Path = filepath.Join(blocker, "latch.json") // parent is a file
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	if f.h.upgradeDeferredByFailureLatch("0.124.0") {
		t.Fatal("an unpersisted latch must not block")
	}
}

func TestStartupUpdateReconcile_LatchesFromTheMarkerFile(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	marker := filepath.Join(t.TempDir(), updater.UpdateMarkerName)
	if err := os.WriteFile(marker, []byte("0.124.0"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, restarted := f.h.startupUpdateReconcile(marker)
	if !restarted || m.Version != "0.124.0" {
		t.Fatalf("got (%+v, %v), want the marker's version and restarted=true", m, restarted)
	}
	if !f.h.upgradeDeferredByFailureLatch("0.124.0") {
		t.Fatal("the version named by the marker must be latched before the first heartbeat")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("the marker must be consumed")
	}

	// A legacy empty marker still means "restarted for an update" (skip
	// jitter) but carries no outcome to record.
	f2 := newOutcomeFixture(t, "0.122.1")
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, restarted := f2.h.startupUpdateReconcile(marker); !restarted {
		t.Fatal("an empty marker still reports a post-update restart")
	}
	if st, ok := f2.h.updateLatch.Load(); ok {
		t.Fatalf("an empty marker latched %+v", st)
	}
}

// The latch must be checked among the gates that run before doUpgrade
// announces the attempt (update_status) or downloads anything.
func TestUpgradeHeldBeforeAttempt_IncludesTheFailureLatch(t *testing.T) {
	f := newOutcomeFixture(t, "0.122.1")
	if f.h.upgradeHeldBeforeAttempt("0.124.0") {
		t.Fatal("nothing latched: the offer must proceed")
	}
	f.h.reconcileUpdateOutcome(updateMarker{Version: "0.124.0", WrittenAt: f.clk.t})
	if !f.h.upgradeHeldBeforeAttempt("0.124.0") {
		t.Fatal("a latched version must be held before the attempt is announced")
	}
	if f.h.upgradeHeldBeforeAttempt("0.125.0") {
		t.Fatal("a different version must proceed")
	}
}

// The hold and the retry are each a warn once per latch state, not per beat.
func TestFirstLatchNotice_OncePerLatchState(t *testing.T) {
	h := &Heartbeat{}
	st := updater.FailureLatchState{Version: "0.124.0", Failures: 1, LastFailureAt: time.Unix(100, 0)}
	if !h.firstLatchNotice("hold", st) || h.firstLatchNotice("hold", st) {
		t.Fatal("hold notice must fire exactly once for one latch state")
	}
	if !h.firstLatchNotice("retry", st) {
		t.Fatal("the retry after a hold is a new notice")
	}
	st.Failures, st.LastFailureAt = 2, time.Unix(200, 0)
	if !h.firstLatchNotice("hold", st) {
		t.Fatal("a new failure is a new latch state")
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
	// One deferral per ~60 s heartbeat for 26 hours of a job that never ends:
	// warn at the start, error at 1 h and again at 25 h, debug otherwise.
	loud := map[int]string{0: "warn", 60: "error", 25 * 60: "error"}
	for minute := 0; minute <= 26*60; minute++ {
		want, ok := loud[minute]
		if !ok {
			want = "debug"
		}
		if got := h.noteUpgradeDeferredByBackup("0.124.0", t0.Add(time.Duration(minute)*time.Minute)); got != want {
			t.Fatalf("at +%dm: level %q, want %q", minute, got, want)
		}
	}
	// A new target is a new episode.
	if got := h.noteUpgradeDeferredByBackup("0.125.0", t0.Add(26*time.Hour+time.Minute)); got != "warn" {
		t.Fatalf("new target: level %q, want warn", got)
	}
	h.clearUpgradeBackupDeferral()
	if got := h.noteUpgradeDeferredByBackup("0.125.0", t0.Add(26*time.Hour)); got != "warn" {
		t.Fatalf("after the deferral cleared, the next one is a new episode; got %q", got)
	}
}

// The heartbeat interval is configurable up to an hour. A slow interval must
// not make every deferral look like a new episode that never escalates.
func TestBackupDeferral_EscalatesOnASlowHeartbeat(t *testing.T) {
	h := &Heartbeat{config: &config.Config{HeartbeatIntervalSeconds: 1800}}
	t0 := time.Date(2026, 10, 20, 2, 41, 0, 0, time.UTC)
	want := []string{"warn", "debug", "error"} // +0, +30m, +60m
	for i, w := range want {
		if got := h.noteUpgradeDeferredByBackup("0.124.0", t0.Add(time.Duration(i)*30*time.Minute)); got != w {
			t.Fatalf("beat %d: level %q, want %q", i, got, w)
		}
	}
}

// A deferral long after the last one (the episode ended without the clear
// call, e.g. an earlier gate returned) is a new episode, not a days-long one.
func TestBackupDeferral_SilenceStartsANewEpisode(t *testing.T) {
	h := &Heartbeat{}
	t0 := time.Date(2026, 10, 20, 2, 41, 0, 0, time.UTC)
	h.noteUpgradeDeferredByBackup("0.124.0", t0)
	if got := h.noteUpgradeDeferredByBackup("0.124.0", t0.Add(3*24*time.Hour)); got != "warn" {
		t.Fatalf("got %q, want a fresh episode after a long silence", got)
	}
	if got := h.noteUpgradeDeferredByBackup("0.124.0", t0.Add(3*24*time.Hour-time.Minute)); got != "warn" {
		t.Fatalf("got %q, want a fresh episode when the clock moves backwards", got)
	}
}
