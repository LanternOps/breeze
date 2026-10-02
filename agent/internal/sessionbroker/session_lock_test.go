package sessionbroker

import "testing"

func TestWTSLockState(t *testing.T) {
	tests := []struct {
		flags         int32
		locked, known bool
	}{
		{0, true, true},    // WTS_SESSIONSTATE_LOCK
		{1, false, true},   // WTS_SESSIONSTATE_UNLOCK
		{-1, false, false}, // WTS_SESSIONSTATE_UNKNOWN
		{7, false, false},
	}
	for _, tt := range tests {
		locked, known := wtsLockState(tt.flags)
		if locked != tt.locked || known != tt.known {
			t.Errorf("wtsLockState(%d) = (%v,%v), want (%v,%v)", tt.flags, locked, known, tt.locked, tt.known)
		}
	}
}
