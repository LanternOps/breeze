package heartbeat

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// Issue #7516: a deploy-before-promote window made every upgrade offer
// unsatisfiable (the server served bytes for a different release than the
// checksum it handed out), and every device retried the whole upgrade once a
// minute with no backoff — up to 2,282 attempts per device in ~8 h, which
// saturated the API. A checksum/manifest failure is deterministic for a target,
// so these paths now back off exponentially per target and retry a NEW target
// on the very next heartbeat.

// checksumErr is the error chain UpdateTo / DownloadBinary return for the
// incident's failure ("checksum verification failed: checksum mismatch: ...").
func checksumErr() error {
	return fmt.Errorf("checksum verification failed: %w",
		fmt.Errorf("%w: expected 0118one, got 0118two", updater.ErrChecksumMismatch))
}

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time          { return c.t }
func (c *testClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func withTestClock(h *Heartbeat) *testClock {
	clk := &testClock{t: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
	h.artifactBackoff.Now = clk.now
	return clk
}

// The incident, replayed: 8 hours of heartbeats at ~60 s, all offering the same
// unsatisfiable target. Before #7516 every beat attempted (480 attempts).
func TestAgentUpgradeChecksumFailure_BacksOffAcrossHeartbeats(t *testing.T) {
	h := &Heartbeat{}
	clk := withTestClock(h)

	attempts := 0
	for beat := 0; beat < 8*60; beat++ {
		if !h.upgradeDeferredByArtifactBackoff("0.118.1") {
			attempts++
			if !h.noteAgentUpgradeArtifactFailure("0.118.1", checksumErr()) {
				t.Fatal("a checksum mismatch must be recorded as a deterministic failure")
			}
		}
		clk.advance(time.Minute)
	}
	// 0, 5, 15, 35, 75, 155, 275, 395 min → 8 attempts.
	if attempts != 8 {
		t.Fatalf("expected 8 attempts over 8 h of heartbeats with exponential backoff, got %d", attempts)
	}
}

// Promoting the build the server holds changes the offer; the device must take
// it on the next heartbeat, not after the old target's backoff.
func TestAgentUpgradeChecksumFailure_NewOfferIsAttemptedImmediately(t *testing.T) {
	h := &Heartbeat{}
	withTestClock(h)
	for i := 0; i < 6; i++ {
		h.noteAgentUpgradeArtifactFailure("0.118.1", checksumErr())
	}
	if h.upgradeDeferredByArtifactBackoff("0.118.2") {
		t.Fatal("a new upgrade target must not wait out the previous target's backoff")
	}
}

// A transient failure (server 503, network) is not deterministic and must keep
// the existing retry-next-heartbeat behaviour.
func TestAgentUpgradeTransientFailure_IsNotBackedOff(t *testing.T) {
	h := &Heartbeat{}
	withTestClock(h)
	err := updater.HTTPStatusErrorf(503, "download failed with status 503")
	if h.noteAgentUpgradeArtifactFailure("0.118.1", err) {
		t.Fatal("a 503 must not be treated as a deterministic artifact failure")
	}
	if h.upgradeDeferredByArtifactBackoff("0.118.1") {
		t.Fatal("a transient failure must not back off the target")
	}
}

func newBackupPresentHeartbeat(t *testing.T, download func(string) (string, error)) *Heartbeat {
	t.Helper()
	installPath := filepath.Join(t.TempDir(), "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing backup binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "0.117.0",
		backupBinaryPath:       installPath,
		backupHelperDownloader: download,
	}
}

// Backup prefetch with a checksum mismatch aborts the agent upgrade (backup
// binary present). Before #7516 the next heartbeat re-ran the whole upgrade —
// update status, user-helper prefetch, backup download — every minute. Now the
// upgrade is deferred, with no download, until the backup target's backoff
// lifts.
func TestBackupPrefetchChecksumFailure_DefersTheUpgradeWithoutDownloading(t *testing.T) {
	var downloads atomic.Int32
	h := newBackupPresentHeartbeat(t, func(string) (string, error) {
		downloads.Add(1)
		return "", checksumErr()
	})
	clk := withTestClock(h)

	if _, abort := h.backupUpgradeCompanion("0.118.1"); !abort {
		t.Fatal("first deterministic failure with a backup binary present must abort the upgrade")
	}
	for beat := 0; beat < 4; beat++ {
		clk.advance(time.Minute)
		if !h.upgradeDeferredByArtifactBackoff("0.118.1") {
			t.Fatalf("beat %d: the upgrade must stay deferred while the backup target backs off", beat+1)
		}
	}
	if got := downloads.Load(); got != 1 {
		t.Fatalf("expected 1 backup download during the backoff window, got %d", got)
	}
	clk.advance(time.Minute) // 5 min: backoff lifts
	if h.upgradeDeferredByArtifactBackoff("0.118.1") {
		t.Fatal("the deferral must lift when the backup backoff expires")
	}
}

// The existing failure cap (#backupPrefetchFailureCap) still bounds how long a
// broken backup artifact can hold the agent back: at the cap the agent upgrade
// proceeds agent-only, and while the backup target is still backing off it
// does so WITHOUT re-downloading the backup artifact.
func TestBackupPrefetchChecksumFailure_CapStillProceedsAgentOnly(t *testing.T) {
	var downloads atomic.Int32
	h := newBackupPresentHeartbeat(t, func(string) (string, error) {
		downloads.Add(1)
		return "", checksumErr()
	})
	clk := withTestClock(h)

	for attempt := 1; attempt <= backupPrefetchFailureCap; attempt++ {
		if h.upgradeDeferredByArtifactBackoff("0.118.1") {
			t.Fatalf("attempt %d: deferred although the backoff should have lifted", attempt)
		}
		pair, abort := h.backupUpgradeCompanion("0.118.1")
		if pair != nil {
			t.Fatalf("attempt %d: expected nil pair", attempt)
		}
		if wantAbort := attempt < backupPrefetchFailureCap; abort != wantAbort {
			t.Fatalf("attempt %d: abort = %v, want %v", attempt, abort, wantAbort)
		}
		clk.advance(updater.TargetBackoffMax)
	}

	// Cap reached and a fresh failure recorded: the next cycle proceeds
	// agent-only with no backup download while that backoff is active.
	h.noteBackupPrefetchFailure("0.118.1")
	h.artifactBackoff.NoteFailure(artifactComponentBackup, "0.118.1")
	before := downloads.Load()
	if h.upgradeDeferredByArtifactBackoff("0.118.1") {
		t.Fatal("past the failure cap the agent upgrade must not be deferred by the backup backoff")
	}
	pair, abort := h.backupUpgradeCompanion("0.118.1")
	if abort || pair != nil {
		t.Fatalf("past the cap: expected proceed agent-only, got pair=%v abort=%v", pair, abort)
	}
	if downloads.Load() != before {
		t.Fatal("a backup target inside its backoff must not be re-downloaded")
	}
}

func TestBackupPrefetchSuccess_ClearsTheBackoff(t *testing.T) {
	fail := true
	tempDL := filepath.Join(t.TempDir(), "dl")
	if err := os.WriteFile(tempDL, []byte("new bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newBackupPresentHeartbeat(t, func(string) (string, error) {
		if fail {
			return "", checksumErr()
		}
		return tempDL, nil
	})
	clk := withTestClock(h)
	h.backupUpgradeCompanion("0.118.1")
	clk.advance(updater.TargetBackoffBase)
	fail = false
	if pair, abort := h.backupUpgradeCompanion("0.118.1"); abort || pair == nil {
		t.Fatalf("expected a staged backup pair, got pair=%v abort=%v", pair, abort)
	}
	if _, active := h.artifactBackoff.Remaining(artifactComponentBackup, "0.118.1"); active {
		t.Fatal("a successful prefetch must clear the backup backoff")
	}
}

// User-helper prefetch is non-fatal, but a deterministic failure must not be
// re-downloaded on every upgrade cycle either.
func TestUserHelperPrefetchChecksumFailure_IsNotRedownloadedDuringBackoff(t *testing.T) {
	var downloads atomic.Int32
	h := &Heartbeat{
		config:         &config.Config{},
		agentVersion:   "0.117.0",
		userHelperGOOS: "windows",
		userHelperDownloader: func(string) (string, error) {
			downloads.Add(1)
			return "", checksumErr()
		},
	}
	clk := withTestClock(h)

	for beat := 0; beat < 5; beat++ {
		if pair := h.prefetchUserHelper("0.118.1", "/opt/breeze/breeze-agent"); pair != nil {
			t.Fatal("a failed prefetch must return nil (agent-only upgrade)")
		}
		clk.advance(time.Minute)
	}
	if got := downloads.Load(); got != 1 {
		t.Fatalf("expected 1 user-helper download inside the backoff window, got %d", got)
	}
	if pair := h.prefetchUserHelper("0.118.2", "/opt/breeze/breeze-agent"); pair != nil || downloads.Load() != 2 {
		t.Fatalf("a new target must be fetched immediately; downloads = %d", downloads.Load())
	}
}

// Watchdog upgrades already had a flat 30-minute cooldown; a deterministic
// failure now also grows the wait exponentially past it.
func TestWatchdogUpgradeChecksumFailure_BacksOffBeyondTheCooldown(t *testing.T) {
	var calls atomic.Int32
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: true},
		agentVersion: "0.118.1",
		watchdogInstaller: func(string) error {
			calls.Add(1)
			return fmt.Errorf("download watchdog: %w", checksumErr())
		},
	}
	clk := withTestClock(h)
	expireCooldown := func() {
		h.watchdogUpgradeMu.Lock()
		h.watchdogLastAttemptAt = time.Now().Add(-2 * watchdogUpgradeRetryCooldown)
		h.watchdogUpgradeMu.Unlock()
	}

	// Drive the streak until its backoff exceeds the 30-minute cooldown.
	for i := 0; i < 4; i++ {
		h.handleWatchdogUpgrade("0.118.1")
		clk.advance(watchdogUpgradeRetryCooldown)
		expireCooldown()
	}
	if calls.Load() != 4 {
		t.Fatalf("setup: expected 4 attempts, got %d", calls.Load())
	}
	// The 4th failure set a 40-minute backoff; 30 minutes in, the flat
	// cooldown alone would retry — the backoff must not.
	h.handleWatchdogUpgrade("0.118.1")
	if calls.Load() != 4 {
		t.Fatal("the watchdog target must stay backed off past the flat cooldown")
	}
	// A new watchdog target is tried at once.
	h.handleWatchdogUpgrade("0.118.2")
	if calls.Load() != 5 {
		t.Fatalf("a new watchdog target must be attempted immediately, calls = %d", calls.Load())
	}
}

func TestArtifactBackoffComponentNamesAreDistinct(t *testing.T) {
	names := []string{artifactComponentAgent, artifactComponentBackup, artifactComponentUserHelper, artifactComponentWatchdog}
	seen := map[string]bool{}
	for _, n := range names {
		if n == "" || seen[n] {
			t.Fatalf("artifact backoff component names must be distinct and non-empty: %v", names)
		}
		seen[n] = true
	}
}
