package pamlifetime

import (
	"path/filepath"
	"testing"
)

func TestStateMachineCleanupTombstoneSurvivesDeliveryPermutations(t *testing.T) {
	sequences := []struct {
		name string
		ops  []byte
	}{
		{"normal", []byte{opApply, opReceived, opVerified, opCleanup, opCleaned}},
		{"duplicate-and-reordered", []byte{opApply, opApply, opVerified, opReceived, opCleanup, opApply, opCleanup, opCleaned}},
		{"offline-reconnect", []byte{opApply, opCleanup, opRestart, opCleanup, opCleaned}},
		{"crash-restart-reboot", []byte{opApply, opRestart, opReboot, opCleanup, opRestart, opReboot, opCleaned}},
		{"disable", []byte{opApply, opDisable, opRestart, opApply, opCleaned}},
	}

	for _, tc := range sequences {
		t.Run(tc.name, func(t *testing.T) {
			runStateMachine(t, tc.ops)
		})
	}
}

const (
	opApply byte = iota
	opCleanup
	opReceived
	opVerified
	opCleaned
	opRestart
	opReboot
	opDisable
)

func runStateMachine(t testing.TB, ops []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := NewStore(path)
	tombstoned := false
	var tombstoneGeneration uint64

	for index, raw := range ops {
		op := raw % 8
		switch op {
		case opApply:
			_, err := store.PrepareApply(validApply(1))
			if tombstoned && err == nil {
				t.Fatalf("step %d: apply succeeded after cleanup tombstone", index)
			}
		case opCleanup, opDisable:
			generation := uint64(2)
			if tombstoneGeneration > generation {
				generation = tombstoneGeneration
			}
			if _, err := store.PrepareCleanup(validCleanup(generation)); err != nil {
				t.Fatalf("step %d: cleanup/disable: %v", index, err)
			}
			tombstoned = true
			tombstoneGeneration = generation
		case opRestart, opReboot:
			store = NewStore(path)
		case opReceived, opVerified, opCleaned:
			// Result emission is deliberately side-effect free for the frozen ledger.
			// Durable transport retries must not rewrite command ownership state.
		}

		entry, exists := store.Entry(testActuationID)
		if tombstoned {
			if !exists {
				t.Fatalf("step %d: cleanup tombstone disappeared", index)
			}
			if entry.DesiredState != DesiredCleanup || entry.Generation < tombstoneGeneration {
				t.Fatalf("step %d: tombstone regressed: %+v", index, entry)
			}
		}
	}
}
