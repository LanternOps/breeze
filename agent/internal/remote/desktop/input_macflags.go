package desktop

import "strings"

// macOS running modifier mask (spec §3, W2c). Before W2c the macOS agent had
// no keycodes for modifier keys, so a held Shift or Cmd (key_down shift) was
// rejected and Shift+click / Cmd+click reached the remote as a plain click.
// In sequenced sessions the agent now holds modifiers: each modifier key_down
// and key_up posts a kCGEventFlagsChanged, and the running mask is set on
// every later key and mouse event. ReleaseAll releases held modifiers through
// key_up, which clears their bits.
//
// Untagged, like input_capslock.go, so this arithmetic runs in the blocking
// Linux CI job; input_darwin.go only reads the results.

// CGEventFlags bits (CoreGraphics/CGEventTypes.h).
const (
	cgEventFlagMaskShift     = 0x00020000
	cgEventFlagMaskControl   = 0x00040000
	cgEventFlagMaskAlternate = 0x00080000
	cgEventFlagMaskCommand   = 0x00100000
)

// macModifierKey maps a modifier key name, and the W2c code for its side, to
// its CGEventFlags bit and macOS virtual keycode (HIToolbox Events.h). The
// names are the ones modifiersToFlags accepts.
func macModifierKey(name, code string) (flag, keycode int, ok bool) {
	right := strings.HasSuffix(code, "Right")
	pick := func(l, r int) int {
		if right {
			return r
		}
		return l
	}
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "shift":
		return cgEventFlagMaskShift, pick(0x38, 0x3C), true
	case "ctrl", "control":
		return cgEventFlagMaskControl, pick(0x3B, 0x3E), true
	case "alt":
		return cgEventFlagMaskAlternate, pick(0x3A, 0x3D), true
	case "meta", "cmd", "win", "super":
		return cgEventFlagMaskCommand, pick(0x37, 0x36), true
	}
	return 0, 0, false
}

type macHeldModifier struct {
	name    string
	flag    int
	keycode int
}

// macModifierMask is the set of modifier keys the agent holds down on a Mac.
// Only the SafeInput worker drives it (through HandleEvent).
type macModifierMask struct {
	held map[string]macHeldModifier // by heldKeyID
}

// press records a modifier key as down. ok is false for a non-modifier key.
func (m *macModifierMask) press(name, code string) (keycode int, ok bool) {
	flag, kc, ok := macModifierKey(name, code)
	if !ok {
		return 0, false
	}
	if m.held == nil {
		m.held = map[string]macHeldModifier{}
	}
	n := heldKeyName(name)
	m.held[heldKeyID(n, code)] = macHeldModifier{name: n, flag: flag, keycode: kc}
	return kc, true
}

// release records a modifier key as up. It matches the exact key first; a
// release with no or another code clears every held key of that name, since
// an extra release is harmless and a latched Cmd is not. ok is false when
// nothing of that name was held.
func (m *macModifierMask) release(name, code string) (keycode int, ok bool) {
	n := heldKeyName(name)
	id := heldKeyID(n, code)
	if k, found := m.held[id]; found {
		delete(m.held, id)
		return k.keycode, true
	}
	for hid, k := range m.held {
		if k.name == n {
			delete(m.held, hid)
			keycode, ok = k.keycode, true
		}
	}
	return keycode, ok
}

func (m *macModifierMask) clear() { m.held = nil }

// flags is the CGEventFlags of every held modifier.
func (m *macModifierMask) flags() int {
	var f int
	for _, k := range m.held {
		f |= k.flag
	}
	return f
}

// macKeyFlags is the flags for a non-modifier key_down/key_up: the held
// modifiers plus the viewer's Caps Lock assertion. set says whether the
// event's flags are set outright; it is false only when nothing is held and
// Caps Lock is not asserted, which is the pre-W2c behaviour (ambient flags).
func macKeyFlags(mask int, capsLock *bool) (flags int, set bool) {
	flags, authoritative := applyCapsLockFlag(mask, capsLock)
	return flags, authoritative || mask != 0
}

// macPointerFlags is the flags for a mouse event: the held modifiers, set
// only when any is held, so a legacy session's mouse events are unchanged.
func macPointerFlags(mask int) (flags int, set bool) {
	return mask, mask != 0
}
