package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #8058 addendum: the TCC check loop runs in every helper, but only the
// desktop helper may prompt or report the remote-desktop permission.
func TestTCCLoopPolicyFor(t *testing.T) {
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper)
	if !desktop.requestScreenRecording || !desktop.promptAccessibility || !desktop.reportRemoteDesktop {
		t.Fatalf("desktop helper policy = %+v, want prompts and remote-desktop reporting allowed", desktop)
	}
	for _, kind := range []string{ipc.HelperBinaryUserHelper, "", "something-else"} {
		if got := tccLoopPolicyFor(kind); got != (tccLoopPolicy{}) {
			t.Fatalf("policy for %q = %+v, want no prompts and no remote-desktop report", kind, got)
		}
	}
}
