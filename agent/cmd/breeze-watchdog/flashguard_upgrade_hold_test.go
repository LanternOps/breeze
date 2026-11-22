package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// A firmware hold is not a failure: no backoff, so the first poll after the
// section ends upgrades. And over a three-hour flash of 30 s polls it is
// journaled once per target, not once per poll.
func TestRunHeartbeatUpgrade_FlashHoldIsNotAFailure(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	t.Cleanup(func() { heldUpgradeJournaled.Delete("agent") })
	now := time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)
	b := &updater.TargetBackoff{Now: func() time.Time { return now }, Rand: func(n int64) int64 { return n - 1 }}

	calls := 0
	held := func() error {
		calls++
		return fmt.Errorf("refused: %w", flashguard.ErrFlashInProgress)
	}
	for poll := 0; poll < 10; poll++ {
		runHeartbeatUpgrade(b, journal, "agent", "0.127.0", held)
		now = now.Add(30 * time.Second)
	}
	if calls != 10 {
		t.Fatalf("a held upgrade was attempted %d times in 10 polls, want 10: it must not back off", calls)
	}

	count := func(event string) int {
		n := 0
		for _, e := range journal.Recent(1000) {
			if e.Event == event {
				n++
			}
		}
		return n
	}
	if got := count("failover.upgrade_agent_held"); got != 1 {
		t.Fatalf("journaled the hold %d times, want 1", got)
	}
	if got := count("failover.upgrade_agent_failed"); got != 0 {
		t.Fatalf("a hold was journaled as a failure %d times", got)
	}

	// A new target is a new hold, journaled again.
	runHeartbeatUpgrade(b, journal, "agent", "0.127.1", held)
	if got := count("failover.upgrade_agent_held"); got != 2 {
		t.Fatalf("a new held target journaled %d holds in total, want 2", got)
	}
}
