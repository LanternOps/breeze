package desktop

// "Release stuck keys" (issue #9595) also clears modifier keys the OS still
// has down although no held record names them. The platform handlers'
// ResetModifierState use these; untagged so the arithmetic runs in the Linux
// CI job.

// winSidedModifiers pairs each sided modifier's virtual key (what
// GetAsyncKeyState reads) with its DOM code (what winKeyInputFor injects).
var winSidedModifiers = []struct {
	vk   uint16
	code string
}{
	{0xA0, "ShiftLeft"}, {0xA1, "ShiftRight"},
	{0xA2, "ControlLeft"}, {0xA3, "ControlRight"},
	{0xA4, "AltLeft"}, {0xA5, "AltRight"},
	{0x5B, "MetaLeft"}, {0x5C, "MetaRight"},
}

// winStuckModifiers returns a release for every sided modifier isDown reports
// down. Only keys that are down are released: a stray Alt or Win key-up is
// not guaranteed to be inert.
func winStuckModifiers(isDown func(vk uint16) bool) []winKeyInput {
	var out []winKeyInput
	for _, m := range winSidedModifiers {
		if !isDown(m.vk) {
			continue
		}
		if k, ok := winKeyInputFor(m.code, "", true, func(uint16) uint16 { return 0 }); ok {
			out = append(out, k)
		}
	}
	return out
}

// macModifierKeycodes is both sides of Shift, Control, Option and Command.
var macModifierKeycodes = []int{0x38, 0x3C, 0x3B, 0x3E, 0x3A, 0x3D, 0x37, 0x36}

// macModifierResetFlags is the flags each release carries during a reset: no
// modifier held, Caps Lock left as it is.
func macModifierResetFlags(current int) int {
	return current & cgEventFlagMaskAlphaShift
}
