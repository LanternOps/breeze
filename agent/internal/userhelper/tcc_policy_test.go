package userhelper

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #8058 addendum: the TCC check loop runs in every helper, but only the
// desktop helper may prompt or report the remote-desktop permission.
func TestTCCLoopPolicyFor(t *testing.T) {
	desktop := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false)
	if !desktop.requestScreenRecording || !desktop.promptAccessibility || !desktop.reportRemoteDesktop || !desktop.diagnoseDenial {
		t.Fatalf("desktop helper policy = %+v, want prompts, remote-desktop reporting and denial diagnosis allowed", desktop)
	}
	for _, kind := range []string{ipc.HelperBinaryUserHelper, "", "something-else"} {
		got := tccLoopPolicyFor(kind, false)
		got.remindPermissions = false
		if got != (tccLoopPolicy{}) {
			t.Fatalf("policy for %q = %+v, want no prompts, no remote-desktop report and no diagnosis", kind, got)
		}
	}
}

// #10190 W04 skew rule, helper side: the helper keeps its own permission
// reminder unless the agent said, at this connection's authentication, that
// it shows the notice itself. An older agent never says so.
func TestTCCLoopRemindsUnlessTheAgentHandlesTheNotice(t *testing.T) {
	for _, kind := range []string{ipc.HelperBinaryDesktopHelper, ipc.HelperBinaryUserHelper} {
		if !tccLoopPolicyFor(kind, false).remindPermissions {
			t.Fatalf("%s: without the flag the helper reminds, as today", kind)
		}
		if tccLoopPolicyFor(kind, true).remindPermissions {
			t.Fatalf("%s: with the flag the agent's notice is the only one", kind)
		}
	}
	// Everything else in the policy is independent of the flag.
	a, b := tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, false), tccLoopPolicyFor(ipc.HelperBinaryDesktopHelper, true)
	a.remindPermissions, b.remindPermissions = false, false
	if a != b {
		t.Fatalf("the flag changed more than the reminder: %+v vs %+v", a, b)
	}
}

func TestShowsOwnTCCReminderReadsTheAuthResponse(t *testing.T) {
	var old ipc.AuthResponse // an older agent: the key is absent
	if err := json.Unmarshal([]byte(`{"accepted":true,"sessionKey":"00","allowedScopes":["desktop"]}`), &old); err != nil {
		t.Fatal(err)
	}
	if !ShowsOwnTCCReminder(old) {
		t.Fatal("old agent + new helper: the helper reminds")
	}
	if ShowsOwnTCCReminder(ipc.AuthResponse{Accepted: true, AgentHandlesTCCNotice: true}) {
		t.Fatal("new agent that handles the notice: the helper stays quiet")
	}
}
