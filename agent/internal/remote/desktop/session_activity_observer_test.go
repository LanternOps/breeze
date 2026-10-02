package desktop

import (
	"sync/atomic"
	"testing"
)

// Every direct WebRTC stop (StopSession, StopAllSessions) tells the activity
// observer to look again, so a caller that mirrors "is anything being
// captured" (the Quick Support viewing indicator) updates at once.
func TestSessionManagerActivityObserverIsToldOfEveryStop(t *testing.T) {
	m := &SessionManager{sessions: map[string]*Session{"a": {}, "b": {}}, config: DefaultConfig()}
	var calls atomic.Int32
	m.SetActivityObserver(func() { calls.Add(1) })

	m.StopSession("a")
	if calls.Load() != 1 {
		t.Fatalf("StopSession: observer calls = %d, want 1", calls.Load())
	}
	m.StopAllSessions()
	if calls.Load() != 2 {
		t.Fatalf("StopAllSessions: observer calls = %d, want 2", calls.Load())
	}
	if m.HasActiveSessions() {
		t.Fatal("no session should remain")
	}
}

func TestSessionManagerWithoutActivityObserverStopsNormally(t *testing.T) {
	m := &SessionManager{sessions: map[string]*Session{"a": {}}, config: DefaultConfig()}
	m.StopSession("a")
	m.StopAllSessions()
}
