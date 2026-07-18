//go:build linux

package x11

import (
	"fmt"
	"runtime"

	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

// Injector performs synthetic input on a dedicated X connection via XTEST.
//
// It intentionally owns its own Conn rather than sharing one with a capturer:
// the AI computer_action tool path (internal/remote/tools/computer_action.go)
// builds an input handler with no capturer present at all, so input must be
// able to stand entirely on its own.
type Injector struct {
	conn   *Conn
	keymap *KeyMap
	root   xproto.Window
}

// NewInjector resolves the display, opens a dedicated connection, and inits XTEST.
func NewInjector() (*Injector, error) {
	target, err := SelectX11Target()
	if err != nil {
		return nil, err
	}
	// The injector performs synthetic input via XTEST and never captures, so it
	// uses the bare (no-SHM) open path.
	conn, err := OpenBare(target)
	if err != nil {
		return nil, err
	}
	if err := xtest.Init(conn.x); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("xtest init: %w", err)
	}
	km, err := LoadKeyMap(conn.x)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	in := &Injector{conn: conn, keymap: km, root: conn.root}
	// Safety net: the InputHandler interface has no Close(), and at least one
	// caller (computer_action.go) constructs a fresh handler — and therefore a
	// fresh Injector/X connection — per single tool invocation with no way to
	// close it. Without this finalizer, every such call would permanently leak
	// a socket fd plus the 4 goroutines xgb spawns per connection. This is a
	// backstop, not a substitute for callers calling Close() when they can.
	runtime.SetFinalizer(in, (*Injector).Close)
	return in, nil
}

// Available reports whether the injector holds a live connection.
func (in *Injector) Available() bool { return in != nil && in.conn != nil }

// MoveMouse warps the pointer to an absolute root-window position.
func (in *Injector) MoveMouse(x, y int) error {
	return xtest.FakeInputChecked(in.conn.x, xproto.MotionNotify, 0,
		xproto.TimeCurrentTime, in.root, int16(x), int16(y), 0).Check()
}

func (in *Injector) button(button byte, press bool) error {
	t := byte(xproto.ButtonPress)
	if !press {
		t = xproto.ButtonRelease
	}
	return xtest.FakeInputChecked(in.conn.x, t, button,
		xproto.TimeCurrentTime, in.root, 0, 0, 0).Check()
}

// ButtonDown presses a pointer button (XTEST numbering: 1=left, 2=middle,
// 3=right, 4=scroll-up, 5=scroll-down).
func (in *Injector) ButtonDown(button byte) error { return in.button(button, true) }

// ButtonUp releases a pointer button.
func (in *Injector) ButtonUp(button byte) error { return in.button(button, false) }

func (in *Injector) key(keycode xproto.Keycode, press bool) error {
	t := byte(xproto.KeyPress)
	if !press {
		t = xproto.KeyRelease
	}
	return xtest.FakeInputChecked(in.conn.x, t, byte(keycode),
		xproto.TimeCurrentTime, in.root, 0, 0, 0).Check()
}

// KeyByName presses+releases a named key, holding Shift for the duration when
// the current keyboard layout requires it to reach that keysym.
func (in *Injector) KeyByName(name string) error {
	ks, ok := KeysymForName(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	return in.KeyBySym(ks)
}

// KeyBySym presses+releases a raw keysym, holding Shift for the duration when
// the current keyboard layout requires it.
func (in *Injector) KeyBySym(keysym uint32) error {
	kc, needShift, ok := in.keymap.Resolve(keysym)
	if !ok {
		return fmt.Errorf("keysym 0x%X not mappable on current layout", keysym)
	}
	shiftKc := in.keymap.ShiftKeycode()
	if needShift && shiftKc != 0 {
		if err := in.key(shiftKc, true); err != nil {
			return err
		}
		defer func() { _ = in.key(shiftKc, false) }()
	}
	if err := in.key(kc, true); err != nil {
		return err
	}
	return in.key(kc, false)
}

// KeyDownByName presses (without releasing) a named key. Used for modifiers
// and for viewer-driven key-down/key-up event pairs.
func (in *Injector) KeyDownByName(name string) error {
	kc, err := in.resolveKeycode(name)
	if err != nil {
		return err
	}
	return in.key(kc, true)
}

// KeyUpByName releases a named key.
func (in *Injector) KeyUpByName(name string) error {
	kc, err := in.resolveKeycode(name)
	if err != nil {
		return err
	}
	return in.key(kc, false)
}

func (in *Injector) resolveKeycode(name string) (xproto.Keycode, error) {
	ks, ok := KeysymForName(name)
	if !ok {
		return 0, fmt.Errorf("unknown key %q", name)
	}
	kc, _, ok := in.keymap.Resolve(ks)
	if !ok {
		return 0, fmt.Errorf("keysym 0x%X not mappable on current layout", ks)
	}
	return kc, nil
}

// Close releases the underlying X connection. Safe to call more than once.
func (in *Injector) Close() {
	if in == nil {
		return
	}
	if in.conn != nil {
		_ = in.conn.Close()
		in.conn = nil
	}
}
