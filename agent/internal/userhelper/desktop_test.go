package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestValidateDesktopStartRequest(t *testing.T) {
	req := &ipc.DesktopStartRequest{
		SessionID:       "desktop-1",
		Offer:           "offer",
		DisplayIndex:    1,
		RevocationLease: &ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: 1, RenewEverySec: 25},
	}
	if err := validateDesktopStartRequest(req); err != nil {
		t.Fatalf("expected valid desktop start request, got %v", err)
	}

	// A start with no revocation lease is refused: without one the control
	// plane could never end this session.
	if err := validateDesktopStartRequest(&ipc.DesktopStartRequest{
		SessionID:    "desktop-1",
		Offer:        "offer",
		DisplayIndex: 1,
	}); err == nil {
		t.Fatal("expected a start with no revocation lease to be rejected")
	}

	// An over-cap max duration is CLAMPED, not rejected — refusing the whole
	// session over a stale policy value would be worse than capping it.
	clamped := &ipc.DesktopStartRequest{
		SessionID:               "desktop-1",
		Offer:                   "offer",
		DisplayIndex:            1,
		MaxSessionDurationHours: 168,
		RevocationLease:         &ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: 1, RenewEverySec: 25},
	}
	if err := validateDesktopStartRequest(clamped); err != nil {
		t.Fatalf("over-cap max duration must be clamped, not rejected: %v", err)
	}
	if clamped.MaxSessionDurationHours != maxSessionDurationHours {
		t.Fatalf("MaxSessionDurationHours = %d, want %d", clamped.MaxSessionDurationHours, maxSessionDurationHours)
	}

	if err := validateDesktopStartRequest(&ipc.DesktopStartRequest{
		SessionID:    "../bad",
		Offer:        "offer",
		DisplayIndex: 1,
	}); err == nil {
		t.Fatal("expected invalid session ID to be rejected")
	}

	if err := validateDesktopStartRequest(&ipc.DesktopStartRequest{
		SessionID:    "desktop-1",
		Offer:        strings.Repeat("o", maxDesktopOfferBytes+1),
		DisplayIndex: 1,
	}); err == nil {
		t.Fatal("expected oversized offer to be rejected")
	}

	if err := validateDesktopStartRequest(&ipc.DesktopStartRequest{
		SessionID:    "desktop-1",
		Offer:        "offer",
		ICEServers:   []byte(strings.Repeat("i", maxDesktopICEBytes+1)),
		DisplayIndex: 1,
	}); err == nil {
		t.Fatal("expected oversized iceServers to be rejected")
	}
}

func TestValidateDesktopStopRequest(t *testing.T) {
	if err := validateDesktopStopRequest(&ipc.DesktopStopRequest{SessionID: "desktop-stop-1"}); err != nil {
		t.Fatalf("expected valid desktop stop request, got %v", err)
	}
	if err := validateDesktopStopRequest(&ipc.DesktopStopRequest{SessionID: "../bad"}); err == nil {
		t.Fatal("expected invalid session ID to be rejected")
	}
}

func TestNewHelperDesktopManagerPreservesDesktopContext(t *testing.T) {
	manager := newHelperDesktopManager(ipc.DesktopContextLoginWindow)
	if got := manager.mgr.CaptureConfig().DesktopContext; got != ipc.DesktopContextLoginWindow {
		t.Fatalf("expected desktop context %q, got %q", ipc.DesktopContextLoginWindow, got)
	}
}
