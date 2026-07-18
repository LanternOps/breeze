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
