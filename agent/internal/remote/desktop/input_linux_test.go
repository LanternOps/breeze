//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestLinuxInputAvailable(t *testing.T) {
	var _ InputHandler = &LinuxInputHandler{} // compile-time interface check

	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	h := NewInputHandler("user_session")
	linuxH, ok := h.(*LinuxInputHandler)
	if !ok {
		t.Fatalf("NewInputHandler returned %T, want *LinuxInputHandler", h)
	}
	defer linuxH.Close()

	if !h.InputAvailable() {
		t.Skip("XTEST not available on this display")
	}
	if err := h.SendMouseMove(5, 5); err != nil {
		t.Fatalf("move: %v", err)
	}
}

func TestWaylandBackendChosenOnce(t *testing.T) {
	calls := 0
	prev := waylandGraphical
	waylandGraphical = func() bool {
		calls++
		return true
	}
	t.Cleanup(func() { waylandGraphical = prev })

	h := NewInputHandler("user_session").(*LinuxInputHandler)
	if !h.InputAvailable() {
		t.Fatal("portal input should be available without an X display")
	}
	_ = h.SendMouseMove(3, 4)
	_ = h.SendMouseDown(3, 4, "left")
	_ = h.SendMouseUp(3, 4, "left")
	_ = h.SendMouseScroll(3, 4, 1)
	_ = h.SendKeyDown("!")
	_ = h.SendKeyUp("!")
	_ = h.SendKeyPress("!", []string{"shift"})
	if calls != 1 {
		t.Fatalf("session probe ran %d times, want 1", calls)
	}
	h.SetDisplayOffset(80, 40)
	if x, y := h.pointer(3, 4); x != 3 || y != 4 {
		t.Fatalf("portal pointer = %d,%d, want 3,4", x, y)
	}
}

func TestX11BackendKeepsDisplayOffset(t *testing.T) {
	prev := waylandGraphical
	waylandGraphical = func() bool { return false }
	t.Cleanup(func() { waylandGraphical = prev })

	h := NewInputHandler("user_session").(*LinuxInputHandler)
	h.SetDisplayOffset(80, 40)
	if x, y := h.pointer(3, 4); x != 83 || y != 44 {
		t.Fatalf("x11 pointer = %d,%d, want 83,44", x, y)
	}
}
