package sessionbroker

import "testing"

// #10190 W05: a Windows session lock / unlock (SCM SessionChange) reaches the
// prompt host, which holds a prompt for a locked session and draws it at
// unlock. A logoff or terminate also releases the hold (the session id can
// be reused by the next logon).
func TestSessionLockObserverMapsSCMEvents(t *testing.T) {
	type call struct {
		ws     uint32
		locked bool
	}
	var got []call
	m := &HelperLifecycleManager{}
	m.observeSessionLock(SCMSessionEvent{EventType: 0x7, SessionID: 3}) // no observer yet: no panic
	m.SetSessionLockObserver(func(ws uint32, locked bool) { got = append(got, call{ws, locked}) })
	for _, ev := range []SCMSessionEvent{
		{EventType: 0x7, SessionID: 3}, // WTS_SESSION_LOCK
		{EventType: 0x8, SessionID: 3}, // WTS_SESSION_UNLOCK
		{EventType: 0x5, SessionID: 4}, // logon: not a lock change
		{EventType: 0x6, SessionID: 5}, // logoff: release
		{EventType: 0xb, SessionID: 6}, // terminate: release
		{EventType: 0x7, SessionID: 0}, // session 0 is never interactive
		{EventType: 0x2, SessionID: 3}, // console disconnect: not a lock change
	} {
		m.observeSessionLock(ev)
	}
	want := []call{{3, true}, {3, false}, {5, false}, {6, false}}
	if len(got) != len(want) {
		t.Fatalf("calls = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("call %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
