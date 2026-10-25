package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

func (r *rebindHarness) swapCount() int {
	n := 0
	for _, e := range r.eventLog() {
		if e == "swap" {
			n++
		}
	}
	return n
}

// The swap and its restart happened but the staged file could not be
// deleted: the restarted process (already the target) only removes it. It
// never re-applies the set or restarts again, which would loop forever.
func TestRebindAppliedSetLeftOnDiskIsOnlyRemoved(t *testing.T) {
	r := newRebindHarness(t)
	r.killAfter = config.RebindPhaseConfirmed
	r.drive(r.directive(rebindGoldenIntent))
	set := r.staged()
	r.killAfter = ""
	r.drive(nil)
	r.waitRestarts(1)
	// The removal "failed": the confirmed set is back on disk.
	if err := config.WriteRebindStaged(r.cfgPath, set); err != nil {
		t.Fatal(err)
	}

	r.restart()
	if r.h.config.AgentID != rebindTestStagedAgentID {
		t.Fatal("the restarted process is not the target")
	}
	swaps := r.swapCount()
	r.h.resumeRebind()
	time.Sleep(50 * time.Millisecond)
	if r.restarts.Load() != 1 {
		t.Fatalf("restarts = %d, want 1: an applied set restarted the agent again", r.restarts.Load())
	}
	if r.swapCount() != swaps {
		t.Fatal("an applied set was applied again")
	}
	if r.staged() != nil || r.h.rebind.pendingOnDisk.Load() {
		t.Fatal("the applied set was not removed")
	}
}
