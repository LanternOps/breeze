//go:build windows

package userhelper

import (
	"os"
	"testing"
)

// TestShowToastWinRTLive raises a real toast through WinRT. It needs an
// interactive desktop and so is opt-in: BREEZE_LIVE_TOAST=1 go test -run
// TestShowToastWinRTLive ./internal/userhelper, or the cross-compiled test
// binary run from a logged-in session on a Windows lab VM.
func TestShowToastWinRTLive(t *testing.T) {
	if os.Getenv("BREEZE_LIVE_TOAST") == "" {
		t.Skip("set BREEZE_LIVE_TOAST=1 to raise a real toast")
	}
	notifyAumidOnce.Do(registerToastAUMID)
	xml := buildToastXML("Breeze live test", "WinRT toast raised without a child process — ✓ émoji 🚀")
	if err := showToastWinRT(notifyAUMID, xml); err != nil {
		t.Fatalf("showToastWinRT: %v", err)
	}
}
