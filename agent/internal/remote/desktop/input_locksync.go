package desktop

import "sync"

// Caps Lock / Num Lock state sync for the Windows and Linux agents (spec §3,
// gotcha K12). The viewer states both states on every key event; the agent
// taps the lock key when the remote state differs. macOS keeps its own Caps
// Lock handling (input_capslock.go) and ignores numLock: Macs have no Num
// Lock state.
//
// Untagged so the decisions are tested on every OS; the platform handlers
// only read the remote state and inject the tap.

// lockSyncPlan is what one key event asks of the lock keys.
type lockSyncPlan struct {
	active      bool  // the event asserts at least one lock state
	caps, num   *bool // nil = not asserted
	suppressKey bool  // the event is itself a lock key whose state is asserted
}

// lockSyncFor decides whether ev drives lock sync.
//
// Only sequenced events (W2b/W2c, seq > 0) do. Viewers since #3595 send
// capsLock on every key event, legacy sessions included, and the Windows and
// Linux agents have always ignored it. Keeping that for seq-less events keeps
// legacy and WebSocket sessions byte-for-byte unchanged; a sequenced session
// also rides the reliable channel, so no assertion is lost.
//
// A lock key whose state is asserted is suppressed: the sync already sets the
// state, and injecting the key as well would flip it straight back.
func lockSyncFor(ev InputEvent) lockSyncPlan {
	switch ev.Type {
	case "key_press", "key_down", "key_up":
	default:
		return lockSyncPlan{}
	}
	if ev.Seq == 0 || (ev.CapsLock == nil && ev.NumLock == nil) {
		return lockSyncPlan{}
	}
	name := heldKeyName(ev.Key)
	isCaps := name == "capslock" || ev.Code == "CapsLock"
	isNum := name == "numlock" || ev.Code == "NumLock"
	return lockSyncPlan{
		active:      true,
		caps:        ev.CapsLock,
		num:         ev.NumLock,
		suppressKey: (isCaps && ev.CapsLock != nil) || (isNum && ev.NumLock != nil),
	}
}

// lockKeySync is the sync state for one lock key.
//
// It acts only when the viewer's asserted state differs from the last one it
// established. That makes it idempotent and keeps it from toggling on every
// event: a remote state read just after our own tap may still be stale, and
// re-reading it on every key would tap again and flip the lock back. The cost
// is that a lock toggled at the remote console stays as the console left it
// until the viewer's own state next changes, which is the conservative choice.
type lockKeySync struct {
	mu    sync.Mutex
	known bool
	last  bool
}

// next reports whether the lock key must be tapped to reach want. current
// reads the remote state (ok false when it cannot be read: then nothing is
// done). After a tap that landed, the caller calls done(want).
func (s *lockKeySync) next(want bool, current func() (on, ok bool)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.known && s.last == want {
		return false
	}
	on, ok := current()
	if !ok {
		return false
	}
	if on == want {
		s.known, s.last = true, want
		return false
	}
	return true
}

// done records that the remote now has state want.
func (s *lockKeySync) done(want bool) {
	s.mu.Lock()
	s.known, s.last = true, want
	s.mu.Unlock()
}
