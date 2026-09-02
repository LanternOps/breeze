package pamlifetime

import "testing"

func FuzzStateMachinePreservesCleanupTombstone(f *testing.F) {
	f.Add([]byte{opApply, opReceived, opCleanup, opCleaned, opRestart, opApply})
	f.Add([]byte{opCleanup, opReboot, opApply, opDisable, opVerified})
	f.Add([]byte{opApply, opApply, opRestart, opCleanup, opCleanup, opReboot})

	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 64 {
			input = input[:64]
		}
		runStateMachine(t, input)
	})
}
