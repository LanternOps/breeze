package desktop

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func boolPtr(b bool) *bool { return &b }

// TestResolveSessionPolicyFromIPCNilPermissive proves the centralized IPC
// decoder maps nil *bool clipboard fields to the permissive default (true).
func TestResolveSessionPolicyFromIPCNilPermissive(t *testing.T) {
	p := ResolveSessionPolicyFromIPC(ipc.DesktopStartRequest{SessionID: "s"})
	if !p.ClipboardHostToViewer || !p.ClipboardViewerToHost {
		t.Fatalf("nil clipboard fields must resolve permissive, got %+v", p)
	}
	if p.IdleTimeout != 0 || p.MaxDuration != 0 {
		t.Fatalf("unset timeouts must be 0, got %+v", p)
	}
}

// TestResolveSessionPolicyFromIPCExplicitFalse proves an explicit false disables
// a direction (distinct from nil).
func TestResolveSessionPolicyFromIPCExplicitFalse(t *testing.T) {
	p := ResolveSessionPolicyFromIPC(ipc.DesktopStartRequest{
		SessionID:             "s",
		ClipboardHostToViewer: boolPtr(false),
		ClipboardViewerToHost: boolPtr(true),
	})
	if p.ClipboardHostToViewer {
		t.Fatal("explicit false host->viewer must disable")
	}
	if !p.ClipboardViewerToHost {
		t.Fatal("explicit true viewer->host must enable")
	}
}

// TestResolveSessionPolicyFromIPCTimeoutUnits proves minute/hour fields are
// decoded with correct units (5 min == 5 minutes, not 5 seconds).
func TestResolveSessionPolicyFromIPCTimeoutUnits(t *testing.T) {
	p := ResolveSessionPolicyFromIPC(ipc.DesktopStartRequest{
		SessionID:               "s",
		IdleTimeoutMinutes:      5,
		MaxSessionDurationHours: 2,
	})
	if p.IdleTimeout != 5*time.Minute {
		t.Fatalf("IdleTimeout=%v want 5m", p.IdleTimeout)
	}
	if p.MaxDuration != 2*time.Hour {
		t.Fatalf("MaxDuration=%v want 2h", p.MaxDuration)
	}
}
