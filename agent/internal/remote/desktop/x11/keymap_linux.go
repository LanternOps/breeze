//go:build linux

package x11

import (
	"fmt"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

// KeyMap resolves keysym → (keycode, needShift) from a live server mapping.
type KeyMap struct {
	minKeycode xproto.Keycode
	perKeycode int
	keysyms    []xproto.Keysym
	shiftKeyc  xproto.Keycode
	reverse    map[uint32]resolved
}

type resolved struct {
	keycode xproto.Keycode
	shift   bool
}

// LoadKeyMap fetches the full keyboard mapping and builds a reverse index.
func LoadKeyMap(x *xgb.Conn) (*KeyMap, error) {
	setup := xproto.Setup(x)
	count := int(setup.MaxKeycode) - int(setup.MinKeycode) + 1
	if count <= 0 {
		return nil, fmt.Errorf("bad keycode range")
	}
	reply, err := xproto.GetKeyboardMapping(x, setup.MinKeycode, byte(count)).Reply()
	if err != nil {
		return nil, fmt.Errorf("get keyboard mapping: %w", err)
	}
	km := &KeyMap{
		minKeycode: setup.MinKeycode,
		perKeycode: int(reply.KeysymsPerKeycode),
		keysyms:    reply.Keysyms,
		reverse:    make(map[uint32]resolved),
	}
	for kc := 0; kc < count; kc++ {
		for col := 0; col < km.perKeycode; col++ {
			ks := uint32(km.keysyms[kc*km.perKeycode+col])
			if ks == 0 {
				continue
			}
			keycode := xproto.Keycode(int(setup.MinKeycode) + kc)
			if ks == 0xFFE1 { // Shift_L
				km.shiftKeyc = keycode
			}
			// Prefer the unshifted (col 0) binding; don't overwrite it.
			if existing, ok := km.reverse[ks]; ok && !existing.shift {
				continue
			}
			km.reverse[ks] = resolved{keycode: keycode, shift: col == 1}
		}
	}
	return km, nil
}

// Resolve returns the keycode and whether Shift must be held for a keysym.
func (k *KeyMap) Resolve(keysym uint32) (xproto.Keycode, bool, bool) {
	r, ok := k.reverse[keysym]
	return r.keycode, r.shift, ok
}

// ShiftKeycode returns the Shift_L keycode (0 if not found).
func (k *KeyMap) ShiftKeycode() xproto.Keycode { return k.shiftKeyc }
