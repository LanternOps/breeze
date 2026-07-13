package sessionbroker

import (
	"runtime"
	"testing"
)

// TestTrackStaleHelperGatedToWindows is the regression test for the
// staleHelpers part of issue #2387: the only drain path (KillStaleHelpers) is
// Windows-only, so tracking on other platforms grows the map unbounded for
// the life of the daemon.
func TestTrackStaleHelperGatedToWindows(t *testing.T) {
	b := &Broker{staleHelpers: make(map[string][]int)}

	b.mu.Lock()
	b.trackStaleHelper("1-user", 4242)
	b.trackStaleHelper("1-user", 4243)
	b.trackStaleHelper("2-system", 4244)
	b.mu.Unlock()

	if runtime.GOOS == "windows" {
		if got := len(b.staleHelpers["1-user"]); got != 2 {
			t.Fatalf("windows: expected 2 tracked PIDs for key 1-user, got %d", got)
		}
		if got := len(b.staleHelpers["2-system"]); got != 1 {
			t.Fatalf("windows: expected 1 tracked PID for key 2-system, got %d", got)
		}
		return
	}

	// Non-Windows: nothing may accumulate — there is no drain path.
	if got := len(b.staleHelpers); got != 0 {
		t.Fatalf("non-windows: staleHelpers must stay empty (no drain path exists), got %d keys: %v",
			got, b.staleHelpers)
	}
}
