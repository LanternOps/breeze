package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #8058 addendum: the TCC check loop runs in every helper, but only the
// desktop helper may prompt or capture.
func TestTCCLoopPolicyFor(t *testing.T) {
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper)
	if !desktop.requestScreenRecording || !desktop.promptAccessibility || !desktop.captureProbe {
		t.Fatalf("desktop helper policy = %+v, want prompts and capture probe allowed", desktop)
	}
	for _, kind := range []string{ipc.HelperBinaryUserHelper, "", "something-else"} {
		if got := tccLoopPolicyFor(kind); got != (tccLoopPolicy{}) {
			t.Fatalf("policy for %q = %+v, want no prompts and no capture probe", kind, got)
		}
	}
}
