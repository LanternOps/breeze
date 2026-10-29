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
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	b := &updater.TargetBackoff{Now: func() time.Time { return now }}

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
	// 0, 5, 15, 35 min → 4 attempts (was 120).
	if calls != 4 {
		t.Fatalf("expected 4 attempts in an hour of failover polls, got %d", calls)
	}

	runHeartbeatUpgrade(b, journal, "agent", "0.118.2", failing)
	if calls != 5 {
		t.Fatal("a new target must be attempted on the next poll")
	}

	// Components are independent: the agent streak does not hold the watchdog.
	runHeartbeatUpgrade(b, journal, "watchdog", "0.118.1", failing)
	if calls != 6 {
		t.Fatal("the watchdog target must not inherit the agent's backoff")
	}
}

func TestRunHeartbeatUpgrade_TransientFailureRetriesNextPoll(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
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
