//go:build linux

package heartbeat

import "testing"

func TestComputeDesktopAccessLinuxShape(t *testing.T) {
	h := &Heartbeat{}
	state := h.computeDesktopAccess(nil)
	if state == nil {
		t.Fatal("linux computeDesktopAccess must never return nil")
	}
	if state.Mode != "user_session" && state.Mode != "unavailable" {
		t.Fatalf("mode must be user_session|unavailable, got %q", state.Mode)
	}
	if state.Mode == "unavailable" && state.Reason == "" {
		t.Fatal("unavailable must carry a reason")
	}
}
