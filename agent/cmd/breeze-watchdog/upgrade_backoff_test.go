package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// #7516: during failover the watchdog acts on upgradeTo / watchdogUpgradeTo
// from every failover heartbeat (30 s by default). An offer whose artifact
// fails checksum verification must back off per target instead of
// re-downloading on every poll; a new target is attempted at once.
func TestRunHeartbeatUpgrade_DeterministicFailureBacksOff(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Close before TempDir cleanup: Windows cannot delete an open journal file.
	t.Cleanup(func() { _ = journal.Close() })
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	// Jitter pinned to the top of its range: waits of ~15 m, then ~45 m.
	b := &updater.TargetBackoff{
		Now:  func() time.Time { return now },
		Rand: func(n int64) int64 { return n - 1 },
	}

	calls := 0
	failing := func() error {
		calls++
		return fmt.Errorf("checksum verification failed: %w",
			fmt.Errorf("%w: expected a, got b", updater.ErrChecksumMismatch))
	}

	for poll := 0; poll < 120; poll++ { // one hour of 30 s failover polls
		runHeartbeatUpgrade(b, journal, "agent", "0.118.1", failing)
		now = now.Add(30 * time.Second)
	}
	// 0 and 15 min → 2 attempts (was 120).
	if calls != 2 {
		t.Fatalf("expected 2 attempts in an hour of failover polls, got %d", calls)
	}

	runHeartbeatUpgrade(b, journal, "agent", "0.118.2", failing)
	if calls != 3 {
		t.Fatal("a new target must be attempted on the next poll")
	}

	// Components are independent: the agent streak does not hold the watchdog.
	runHeartbeatUpgrade(b, journal, "watchdog", "0.118.1", failing)
	if calls != 4 {
		t.Fatal("the watchdog target must not inherit the agent's backoff")
	}
}

func TestRunHeartbeatUpgrade_TransientFailureRetriesNextPoll(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Close before TempDir cleanup: Windows cannot delete an open journal file.
	t.Cleanup(func() { _ = journal.Close() })
	b := &updater.TargetBackoff{}
	calls := 0
	transient := func() error {
		calls++
		return updater.HTTPStatusErrorf(503, "download failed with status 503")
	}
	runHeartbeatUpgrade(b, journal, "agent", "0.118.1", transient)
	runHeartbeatUpgrade(b, journal, "agent", "0.118.1", transient)
	if calls != 2 {
		t.Fatalf("a transient failure must retry on the next poll, got %d calls", calls)
	}
}
