package x11

// LockMask is the core-protocol modifier bit for Caps Lock (the Lock row).
const LockMask uint16 = 1 << 1

// modifierMaskForKeycode returns the modifier bit whose row in a
// GetModifierMapping reply contains kc, or 0. Num Lock has no fixed modifier
// bit (commonly Mod2, but the layout decides), so it is looked up rather than
// assumed. perRow is KeycodesPerModifier; codes holds 8 rows of perRow
// keycodes, padded with 0.
func modifierMaskForKeycode(perRow int, codes []byte, kc byte) uint16 {
	if perRow <= 0 || kc == 0 {
		return 0
	}
	for row := 0; row < 8; row++ {
		for i := 0; i < perRow; i++ {
			idx := row*perRow + i
			if idx >= len(codes) {
				return 0
			}
			if codes[idx] == kc {
				return 1 << row
			}
		}
	}
	return 0
}
