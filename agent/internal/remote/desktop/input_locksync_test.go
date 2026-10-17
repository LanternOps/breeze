package desktop

import "testing"

func TestLockSyncForLegacyInactive(t *testing.T) {
	on := true
	// Seq 0 is a legacy (or WebSocket) event. Viewers since #3595 already send
	// capsLock on every key, and Windows/Linux ignored it; they still do, so a
	// legacy session behaves exactly as before.
	for _, ev := range []InputEvent{
		{Type: "key_down", Key: "a", CapsLock: &on},
		{Type: "key_down", Key: "a", CapsLock: &on, NumLock: &on},
		{Type: "key_down", Key: "capslock", CapsLock: &on},
	} {
		if p := lockSyncFor(ev); p.active || p.suppressKey {
			t.Fatalf("legacy %+v: plan %+v, want inactive", ev, p)
		}
	}
}

func TestLockSyncForSequenced(t *testing.T) {
	on, off := true, false
	cases := []struct {
		name     string
		ev       InputEvent
		active   bool
		suppress bool
	}{
		{"no state stated", InputEvent{Type: "key_down", Key: "a", Seq: 3}, false, false},
		{"pointer event", InputEvent{Type: "mouse_down", Seq: 3, CapsLock: &on}, false, false},
		{"caps stated", InputEvent{Type: "key_down", Key: "a", Seq: 3, CapsLock: &on}, true, false},
		{"num stated", InputEvent{Type: "key_up", Key: "a", Seq: 3, NumLock: &off}, true, false},
		{"caps key with caps stated", InputEvent{Type: "key_down", Key: "CapsLock", Seq: 3, CapsLock: &on}, true, true},
		{"caps key by code", InputEvent{Type: "key_up", Key: "x", Code: "CapsLock", Seq: 3, CapsLock: &on}, true, true},
		{"num key with num stated", InputEvent{Type: "key_press", Key: "numlock", Seq: 3, NumLock: &on}, true, true},
		// The key is suppressed only when its own state is asserted.
		{"num key, only caps stated", InputEvent{Type: "key_down", Key: "numlock", Seq: 3, CapsLock: &on}, true, false},
		{"caps key, only num stated", InputEvent{Type: "key_down", Key: "capslock", Seq: 3, NumLock: &on}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := lockSyncFor(tc.ev)
			if p.active != tc.active || p.suppressKey != tc.suppress {
				t.Fatalf("plan %+v, want active=%v suppress=%v", p, tc.active, tc.suppress)
			}
			if p.active && (p.caps != tc.ev.CapsLock || p.num != tc.ev.NumLock) {
				t.Fatalf("plan states caps=%v num=%v, want the event's", p.caps, p.num)
			}
		})
	}
}

// fakeLock is a remote lock key: state, plus a count of how often it was read.
type fakeLock struct {
	on    bool
	ok    bool
	reads int
}

func (f *fakeLock) read() (bool, bool) { f.reads++; return f.on, f.ok }

func TestLockKeySyncTapsOnlyOnMismatch(t *testing.T) {
	var s lockKeySync
	remote := &fakeLock{on: true, ok: true}
	if s.next(true, remote.read) {
		t.Fatal("remote already on: no tap")
	}
	remote2 := &fakeLock{on: false, ok: true}
	var s2 lockKeySync
	if !s2.next(true, remote2.read) {
		t.Fatal("remote off, viewer on: tap")
	}
}

// Idempotent, and it does not toggle on every event: once a state has been
// established, the same assertion does not even read the remote state again.
// A stale read right after our own tap can therefore never cause a second tap.
func TestLockKeySyncSameAssertionIsANoOp(t *testing.T) {
	var s lockKeySync
	remote := &fakeLock{on: false, ok: true}
	if !s.next(true, remote.read) {
		t.Fatal("first assertion should tap")
	}
	s.done(true)
	// The OS has not caught up yet (stale read says off). Must not tap again.
	for i := 0; i < 10; i++ {
		if s.next(true, remote.read) {
			t.Fatalf("event %d: tapped again for an assertion already applied", i)
		}
	}
	if remote.reads != 1 {
		t.Fatalf("remote read %d times, want 1", remote.reads)
	}
	// The viewer's state changes: read and tap again.
	remote.on = true
	if !s.next(false, remote.read) {
		t.Fatal("changed assertion should tap")
	}
}

// A tap that did not land is not recorded, so the next event retries.
func TestLockKeySyncRetriesAfterFailedTap(t *testing.T) {
	var s lockKeySync
	remote := &fakeLock{on: false, ok: true}
	if !s.next(true, remote.read) {
		t.Fatal("want tap")
	}
	// No done(): the tap failed.
	if !s.next(true, remote.read) {
		t.Fatal("want retry after a failed tap")
	}
}

// When the state cannot be read, do nothing rather than guess.
func TestLockKeySyncUnreadableStateDoesNothing(t *testing.T) {
	var s lockKeySync
	remote := &fakeLock{ok: false}
	if s.next(true, remote.read) || s.next(false, remote.read) {
		t.Fatal("unreadable state must not tap")
	}
}

// A matching remote state is recorded, so later identical assertions skip the read.
func TestLockKeySyncRecordsMatch(t *testing.T) {
	var s lockKeySync
	remote := &fakeLock{on: true, ok: true}
	s.next(true, remote.read)
	s.next(true, remote.read)
	if remote.reads != 1 {
		t.Fatalf("reads = %d, want 1", remote.reads)
	}
}
