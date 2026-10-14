//go:build linux

package desktop

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// LinuxInputHandler injects input via XTEST on a lazily-opened dedicated X
// connection (see x11.Injector). Constructing a handler never blocks or
// fails even when no display exists yet — the connection is opened on first
// use so a handler can be created speculatively (e.g. before a session or
// display is known to be ready).
type LinuxInputHandler struct {
	mu    sync.Mutex
	inj   *x11.Injector
	tried bool
	offX  int
	offY  int

	// W2c lock-key sync (sequenced sessions only; see lockSyncFor).
	capsSync lockKeySync
	numSync  lockKeySync
}

var _ InputHandler = (*LinuxInputHandler)(nil)

// NewInputHandler creates a Linux input handler backed by XTEST.
func NewInputHandler(_ string) InputHandler {
	return &LinuxInputHandler{}
}

// injector returns the lazily-opened injector, or nil if opening has already
// been attempted and failed (e.g. no display present).
func (h *LinuxInputHandler) injector() *x11.Injector {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.inj != nil {
		return h.inj
	}
	if h.tried {
		return nil
	}
	h.tried = true
	if inj, err := x11.NewInjector(); err == nil {
		h.inj = inj
	}
	return h.inj
}

// InputAvailable reports whether the injector opened and XTEST is live.
func (h *LinuxInputHandler) InputAvailable() bool {
	return h.injector().Available()
}

// SetAtLoginWindow is a no-op on Linux — XTEST works identically in both contexts.
func (h *LinuxInputHandler) SetAtLoginWindow(_ bool) {}

// Close releases the underlying X connection, if one was opened. Not part of
// the InputHandler interface (which has no Close method and is shared with
// platforms that hold no such resource) — callers that own a
// *LinuxInputHandler for a bounded lifetime (rather than relying on the
// x11.Injector finalizer as a backstop) should call this explicitly when
// done. Safe to call on a handler that never opened a connection.
func (h *LinuxInputHandler) Close() {
	h.mu.Lock()
	inj := h.inj
	h.inj = nil
	h.mu.Unlock()
	if inj != nil {
		inj.Close()
	}
}

// SetDisplayOffset stores the virtual-screen offset applied to mouse moves.
func (h *LinuxInputHandler) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	h.offX, h.offY = x, y
	h.mu.Unlock()
}

func (h *LinuxInputHandler) displayOffset() (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.offX, h.offY
}

func (h *LinuxInputHandler) SendMouseMove(x, y int) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	offX, offY := h.displayOffset()
	return inj.MoveMouse(x+offX, y+offY)
}

func (h *LinuxInputHandler) SendMouseDown(x, y int, button string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	return inj.ButtonDown(x11ButtonCode(button))
}

func (h *LinuxInputHandler) SendMouseUp(x, y int, button string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	// Position the cursor before releasing — ensures the release lands at
	// the correct end-of-drag coordinate (e.g. for text selection), mirroring
	// the Windows/macOS handlers rather than the old xdotool behavior (which
	// released wherever the pointer already was).
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	return inj.ButtonUp(x11ButtonCode(button))
}

func (h *LinuxInputHandler) SendMouseClick(x, y int, button string) error {
	if err := h.SendMouseDown(x, y, button); err != nil {
		return err
	}
	return h.SendMouseUp(x, y, button)
}

func (h *LinuxInputHandler) SendMouseScroll(x, y int, delta int) error {
	return h.sendMouseScroll(x, y, delta, 0)
}

// sendMouseScroll clicks the XTEST scroll buttons x11ScrollClicksFor picks:
// 4/5 vertical as before W2c, 6/7 for a W2c deltaX.
func (h *LinuxInputHandler) sendMouseScroll(x, y, delta, deltaX int) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	for _, c := range x11ScrollClicksFor(delta, deltaX) {
		for i := 0; i < c.Count; i++ {
			if err := inj.ButtonDown(c.Button); err != nil {
				return err
			}
			if err := inj.ButtonUp(c.Button); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *LinuxInputHandler) SendKeyPress(key string, modifiers []string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	for _, m := range modifiers {
		_ = inj.KeyDownByName(canonicalModifierName(m))
	}
	err := inj.KeyByName(key)
	for i := len(modifiers) - 1; i >= 0; i-- {
		_ = inj.KeyUpByName(canonicalModifierName(modifiers[i]))
	}
	return err
}

func (h *LinuxInputHandler) SendKeyDown(key string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	return inj.KeyDownByName(canonicalModifierName(key))
}

func (h *LinuxInputHandler) SendKeyUp(key string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	return inj.KeyUpByName(canonicalModifierName(key))
}

// HandleEvent dispatches an InputEvent (mirrors the Windows/macOS handlers).
func (h *LinuxInputHandler) HandleEvent(event InputEvent) error {
	switch event.Type {
	case "mouse_move":
		return h.SendMouseMove(event.X, event.Y)
	case "mouse_click":
		return h.SendMouseClick(event.X, event.Y, event.Button)
	case "mouse_down":
		return h.SendMouseDown(event.X, event.Y, event.Button)
	case "mouse_up":
		return h.SendMouseUp(event.X, event.Y, event.Button)
	case "mouse_scroll":
		return h.sendMouseScroll(event.X, event.Y, event.Delta, event.DeltaX)
	}
	// Key events. Lock state first (sequenced sessions only); a lock key whose
	// state is asserted is not injected, or it would flip the state back.
	if plan := lockSyncFor(event); plan.active {
		capsOK, numOK := h.syncLockKeys(plan)
		if plan.suppress(capsOK, numOK) {
			return nil
		}
	}
	switch event.Type {
	case "key_press":
		return h.SendKeyPress(event.Key, event.Modifiers)
	case "key_down":
		return h.SendKeyDown(event.Key)
	case "key_up":
		return h.SendKeyUp(event.Key)
	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}
}

// syncLockKeys brings Caps Lock and Num Lock to the states plan asserts.
// X autorepeats keys held through XTEST, so a W2c repeat key_down is never
// needed here (the viewer does not forward repeats to Linux remotes).
//
// It reports which lock states could be read, i.e. which locks the agent
// owns: a lock key whose state cannot be read (no X injector, or Num_Lock
// bound to no modifier) is injected as a plain key instead of suppressed.
func (h *LinuxInputHandler) syncLockKeys(plan lockSyncPlan) (capsOK, numOK bool) {
	inj := h.injector()
	if inj == nil {
		return false, false
	}
	caps, num, numBound, err := inj.LockStates()
	if err != nil {
		slog.Debug("Lock state read failed", "error", err.Error())
		return false, false
	}
	capsOK, numOK = true, numBound
	if plan.caps != nil {
		readCaps := func() (bool, bool) { return caps, true }
		if h.capsSync.next(*plan.caps, readCaps) {
			h.tapLock(inj, &h.capsSync, "capslock", *plan.caps)
		}
	}
	if plan.num != nil && numBound {
		readNum := func() (bool, bool) { return num, true }
		if h.numSync.next(*plan.num, readNum) {
			h.tapLock(inj, &h.numSync, "numlock", *plan.num)
		}
	}
	return capsOK, numOK
}

// tapLock taps a lock key and records the new state only when the tap
// landed; otherwise the next event retries.
func (h *LinuxInputHandler) tapLock(inj *x11.Injector, s *lockKeySync, name string, want bool) {
	if err := inj.TapKeyByName(name); err != nil {
		slog.Warn("Lock key sync tap failed", "lock", name, "error", err.Error())
		return
	}
	s.done(want)
}

// canonicalModifierName maps the "win"/"lwin"/"rwin" Super aliases — accepted
// by the old xdotool-based handler and still accepted by the Windows/macOS
// handlers — onto "super", which x11.KeysymForName does recognize (alongside
// "meta"/"cmd", already handled natively). x11.KeysymForName already covers
// every other modifier alias ("ctrl"/"control", "alt", "shift") natively, so
// this only needs to plug that one gap. Everything else passes through
// untouched — this is also used for plain SendKeyDown/SendKeyUp key names,
// where it's a harmless no-op for anything not in the switch.
func canonicalModifierName(name string) string {
	switch strings.ToLower(name) {
	case "win", "lwin", "rwin":
		return "super"
	default:
		return name
	}
}
