package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestValidateDesktopStartRequest(t *testing.T) {
	req := &ipc.DesktopStartRequest{
		SessionID:    "desktop-1",
		Offer:        "offer",
		DisplayIndex: 1,
	}
	if err := validateDesktopStartRequest(req); err != nil {
		t.Fatalf("expected valid desktop start request, got %v", err)
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
