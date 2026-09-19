package userhelper

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// The helper is the last gate before a session starts capturing, and it must
// apply exactly the same lease rules as the agent's map-payload decoder. A
// lease block that cannot be renewed (no cadence) or cannot lapse (no expiry)
// is not a lease: accepting it produced a session the control plane could never
// end, which is precisely what the required-lease rule exists to prevent.
func TestValidateDesktopStartRequestRejectsAnUnusableLease(t *testing.T) {
	base := func(lease *ipc.RevocationLease) *ipc.DesktopStartRequest {
		return &ipc.DesktopStartRequest{
			SessionID:       "desktop-1",
			Offer:           "offer",
			DisplayIndex:    1,
			RevocationLease: lease,
		}
	}

	tests := []struct {
		name  string
		lease *ipc.RevocationLease
	}{
		{"nil lease", nil},
		{"all-zero lease", &ipc.RevocationLease{}},
		{"no expiry", &ipc.RevocationLease{Token: "t", RenewEverySec: 25}},
		{"no renew cadence", &ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: time.Now().UnixMilli()}},
		{"negative renew cadence", &ipc.RevocationLease{
			Token: "t", ExpiresAtUnixMs: time.Now().UnixMilli(), RenewEverySec: -1,
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateDesktopStartRequest(base(tt.lease))
			if err == nil {
				t.Fatal("expected an unusable lease to be rejected")
			}
			if !errors.Is(err, desktop.ErrRevocationLeaseRequired) {
				t.Fatalf("error = %v, want it to wrap ErrRevocationLeaseRequired", err)
			}
		})
	}

	// Positive control: a well-formed lease still starts.
	ok := base(&ipc.RevocationLease{
		Token:           "t",
		ExpiresAtUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		RenewEverySec:   25,
		GraceSec:        90,
	})
	if err := validateDesktopStartRequest(ok); err != nil {
		t.Fatalf("a well-formed lease must be accepted, got %v", err)
	}
}

// The helper's SessionManager has no command WebSocket, so unless the helper
// wires the IPC bridge its lease watchdog asks nothing of anyone and every
// session dies at expiresAt+grace. This asserts the wiring exists and speaks
// the right message type.
func TestHelperDesktopManagerWiresTheLeaseBridge(t *testing.T) {
	h := newHelperDesktopManager("")
	if h.mgr.RequestRevocationLeaseRenew != nil {
		t.Fatal("bridge must be wired by the client, not preset by the constructor")
	}

	type sentMsg struct {
		msgType string
		payload any
	}
	sent := make(chan sentMsg, 1)
	h.mgr.WireHelperRevocationLease(func(msgType string, payload any) error {
		sent <- sentMsg{msgType, payload}
		return nil
	})
	if h.mgr.RequestRevocationLeaseRenew == nil {
		t.Fatal("WireHelperRevocationLease left the renew callback nil")
	}

	h.mgr.RequestRevocationLeaseRenew("desk-1")
	select {
	case msg := <-sent:
		if msg.msgType != ipc.TypeDesktopLeaseRenew {
			t.Fatalf("msgType = %q, want %q", msg.msgType, ipc.TypeDesktopLeaseRenew)
		}
		req, ok := msg.payload.(ipc.DesktopLeaseRenewRequest)
		if !ok {
			t.Fatalf("payload = %T, want ipc.DesktopLeaseRenewRequest", msg.payload)
		}
		if req.SessionID != "desk-1" {
			t.Fatalf("sessionId = %q", req.SessionID)
		}
	case <-time.After(time.Second):
		t.Fatal("no renew request left the helper")
	}
}
