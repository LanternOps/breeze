package desktop

import "strings"

// Caps Lock is a toggle at the OS/HID layer, not a key that is "held", so the
// viewer states the resulting state on every keyboard event instead of sending
// a press the agent has to interpret. See issue #3595.
//
// This file is deliberately untagged: the policy below is pure Go and is what
// the CI unit job can actually execute. The platform job runs
// `CGO_ENABLED=0 go test ./...` on Linux, so anything living in the
// `darwin && cgo` input file is compiled by the macOS *build* job and never
// covered by a test anywhere.
const capsLockKeyName = "capslock"

// cgEventFlagMaskAlphaShift is kCGEventFlagMaskAlphaShift from
// CoreGraphics/CGEventTypes.h — the Caps Lock bit in a CGEventFlags mask.
// Duplicated as an untyped constant (rather than read through cgo) so the flag
// arithmetic can be unit-tested off a Mac.
const cgEventFlagMaskAlphaShift = 0x00010000

// isCapsLockKey reports whether a viewer key name refers to Caps Lock.
func isCapsLockKey(key string) bool {
	return strings.ToLower(strings.TrimSpace(key)) == capsLockKeyName
}

// applyCapsLockFlag folds the viewer's Caps Lock assertion into a CGEventFlags
// mask.
//
// The second return value is what preserves backward compatibility: a viewer
// that predates issue #3595 sends no state at all, so `capsLock` is nil, and
// the caller must keep its existing behaviour rather than assuming "off". Only
// when the viewer actually states the state does the agent take ownership of
// the bit.
//
// Note that "off" CLEARS the bit rather than merely not setting it. The mask
// the caller passes in can already carry a latched AlphaShift picked up from
// the remote machine's ambient modifier state — that latch is exactly the
// desync behind #3595's intermittent uppercase output.
func applyCapsLockFlag(flags int, capsLock *bool) (int, bool) {
	if capsLock == nil {
		return flags, false
	}
	if *capsLock {
		return flags | cgEventFlagMaskAlphaShift, true
	}
	return flags &^ cgEventFlagMaskAlphaShift, true
}

// suppressCapsLockKey reports whether a keyboard event for the Caps Lock key
// should be swallowed rather than injected.
//
// True only when the viewer states its Caps Lock state: that state already
// rides on every keystroke, so the key itself has nothing left to do, and
// synthesising macOS keycode 0x39 is what desynced the remote AlphaShift state
// to begin with (macOS reports Caps Lock via flagsChanged, not as a key press,
// so a synthetic down/up pair either does nothing or latches a state nothing
// clears). A viewer that states nothing keeps today's injection.
func suppressCapsLockKey(key string, capsLock *bool) bool {
	return capsLock != nil && isCapsLockKey(key)
}
