//go:build darwin && cgo

package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// #8390: the connect-time capability check (and the re-probe that re-runs
// it) derives CanCapture from the non-capturing access check. Unknown lets a
// session try; only a known denial reports CanCapture=false.
func TestDetectCapabilities_UsesAccessCheck(t *testing.T) {
	orig := checkCaptureAccessFn
	t.Cleanup(func() { checkCaptureAccessFn = orig })

	for _, tc := range []struct {
		state desktop.CaptureAccessState
		want  bool
	}{
		{desktop.CaptureAccessGranted, true},
		{desktop.CaptureAccessUnknown, true},
		{desktop.CaptureAccessDenied, false},
	} {
		var gotContext string
		checkCaptureAccessFn = func(cfg desktop.CaptureConfig) desktop.CaptureAccessReport {
			gotContext = cfg.DesktopContext
			return desktop.CaptureAccessReport{State: tc.state, Reason: "test"}
		}
		t.Setenv("DISPLAY", "")
		caps := detectCapabilities(ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)
		if caps.CanCapture != tc.want {
			t.Fatalf("%v: CanCapture = %t, want %t", tc.state, caps.CanCapture, tc.want)
		}
		if gotContext != ipc.DesktopContextUserSession {
			t.Fatalf("access check context = %q", gotContext)
		}
	}
}
