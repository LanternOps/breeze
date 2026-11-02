package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

func TestDesktopRelayOnlyPassesThroughHelper(t *testing.T) {
	req := ipc.DesktopStartRequest{SessionID: "desktop-relay", Offer: "invalid-offer", RelayOnly: true}
	if policy := desktop.ResolveSessionPolicyFromIPC(req); !policy.RelayOnly {
		t.Error("IPC decoder discarded RelayOnly")
	}
	helper := &helperDesktopManager{mgr: &desktop.SessionManager{}}
	_, err := helper.startSession(&req)
	if err == nil || err.Error() != "start desktop session: relay-only desktop session has no TURN server" {
		t.Fatalf("helper must reject missing TURN before creating a peer connection: %v", err)
	}
}
