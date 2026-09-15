package heartbeat

import "testing"

// SEC-038 W05 — the two properties that separate this wave from W04, written
// against ONLY the symbols W04 already had.
//
// That restraint is deliberate: this file is also the CONTROL suite for the
// native Windows evidence run required by the plan (owner decision 3). It
// compiles unchanged against origin/main, where both assertions FAIL — the
// W04 fence is in-memory only, so a "restarted" fence knows nothing and
// admits the replay. On this branch they pass, because a fence with no
// in-process record of a session refuses the start until the control plane
// confirms it (and, in production, because the record was reloaded from the
// durable store). A green candidate with no failing control would prove the
// suite ran, not that it discriminates.

// A start redelivered after the agent restarts must not run just because the
// process that tombstoned the session is gone.
func TestDesktopFenceRefusesAReplayAfterRestart(t *testing.T) {
	before := &desktopFence{}
	before.noteStop("sess-restart", desktopStopFenceInput{Generation: 4, HasGeneration: true})

	// A brand-new fence is what the next process starts with.
	after := &desktopFence{}
	if d := after.admitStart("sess-restart", desktopStartFenceInput{
		Generation:    3,
		HasGeneration: true,
		CommandID:     "replayed",
	}); d.Admitted {
		t.Fatalf("a start replayed after a restart must not be admitted on the payload alone, got %#v", d)
	}
}

// More generally: any generation-bearing start for a session the fence has no
// record of must not be admitted without confirmation.
func TestDesktopFenceRefusesUnknownSessionWithoutConfirmation(t *testing.T) {
	var f desktopFence
	if d := f.admitStart("sess-unknown", desktopStartFenceInput{
		Generation:    9,
		HasGeneration: true,
		CommandID:     "c",
	}); d.Admitted {
		t.Fatalf("an unconfirmed session must not admit a start, got %#v", d)
	}
}
