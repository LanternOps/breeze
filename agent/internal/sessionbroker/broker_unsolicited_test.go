package sessionbroker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShouldForwardUnsolicitedHelperMessage(t *testing.T) {
	t.Parallel()

	session := &Session{AllowedScopes: []string{"tray", "desktop"}}

	tests := []struct {
		msgType string
		want    bool
	}{
		{ipc.TypeTrayAction, true},
		{ipc.TypeSASRequest, true},
		{ipc.TypeDesktopPeerDisconnected, true},
		{ipc.TypeDesktopClipboardSummary, true},
		{ipc.TypeNotifyResult, false},
		{ipc.TypeClipboardData, false},
		{ipc.TypeCommandResult, false},
		{backupipc.TypeBackupProgress, false},
	}

	for _, tt := range tests {
		got := shouldForwardUnsolicitedHelperMessage(session, &ipc.Envelope{Type: tt.msgType})
		if got != tt.want {
			t.Fatalf("shouldForwardUnsolicitedHelperMessage(%q) = %v, want %v", tt.msgType, got, tt.want)
		}
	}
}

func TestSanitizeCapabilitiesForSessionScopes(t *testing.T) {
	t.Parallel()

	session := &Session{AllowedScopes: []string{"notify", "clipboard"}}
	caps := sanitizeCapabilitiesForSession(session, &ipc.Capabilities{
		CanNotify:     true,
		CanTray:       true,
		CanCapture:    true,
		CanClipboard:  true,
		DisplayServer: "  " + "wayland" + "  ",
	})

	if !caps.CanNotify {
		t.Fatal("expected notify capability to remain enabled")
	}
	if caps.CanTray {
		t.Fatal("expected tray capability to be stripped without tray scope")
	}
	if caps.CanCapture {
		t.Fatal("expected capture capability to be stripped without desktop scope")
	}
	if !caps.CanClipboard {
		t.Fatal("expected clipboard capability to remain enabled")
	}
	if caps.DisplayServer != "wayland" {
		t.Fatalf("DisplayServer = %q, want %q", caps.DisplayServer, "wayland")
	}
}

func TestSanitizeTCCStatusForSessionScopes(t *testing.T) {
	t.Parallel()

	status := &ipc.TCCStatus{
		ScreenRecording: true,
		Accessibility:   true,
		FullDiskAccess:  true,
		CheckedAt:       time.Now(),
	}

	if got := sanitizeTCCStatusForSession(&Session{AllowedScopes: []string{"notify"}}, status); got != nil {
		t.Fatal("expected non-desktop session TCC status to be rejected")
	}

	got := sanitizeTCCStatusForSession(&Session{AllowedScopes: []string{"desktop"}}, status)
	if got == nil {
		t.Fatal("expected desktop session TCC status to be accepted")
	}
	if got == status {
		t.Fatal("expected sanitized TCC status to be copied, not aliased")
	}
	if !got.ScreenRecording || !got.Accessibility || !got.FullDiskAccess {
		t.Fatalf("unexpected sanitized TCC status: %+v", got)
	}
}

// #8390: the docs point operators at screenRecordingState on the "TCC
// permissions received" line to tell an unverified grant from a known one.
// Not parallel: captureLogs swaps the global logger.
func TestDispatchTCCStatusLogsScreenRecordingState(t *testing.T) {
	logs := captureLogs(t)
	payload, err := json.Marshal(ipc.TCCStatus{
		ScreenRecording:      true,
		ScreenRecordingState: "unknown",
		CheckedAt:            time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Session{UID: 501, SessionID: "tcc-log", AllowedScopes: []string{"desktop"}}
	(&Broker{}).dispatchHelperMessage(s, &ipc.Envelope{Type: ipc.TypeTCCStatus, Payload: payload})

	out := logs.String()
	if !strings.Contains(out, "TCC permissions received") {
		t.Fatalf("TCC status not logged; logs:\n%s", out)
	}
	if !strings.Contains(out, "screenRecordingState=unknown") {
		t.Fatalf("TCC log line lacks screenRecordingState; logs:\n%s", out)
	}
}

func TestClipboardSummaryNeedsDesktopScope(t *testing.T) {
	t.Parallel()
	session := &Session{AllowedScopes: []string{"tray"}}
	if shouldForwardUnsolicitedHelperMessage(session, &ipc.Envelope{Type: ipc.TypeDesktopClipboardSummary}) {
		t.Fatal("a helper without the desktop scope must not report desktop clipboard summaries")
	}
}

// #9182: a helper-hosted session trickles its late ICE candidates to the
// service. Only a desktop-scoped helper may.
func TestLocalICECandidateNeedsDesktopScope(t *testing.T) {
	t.Parallel()
	env := &ipc.Envelope{Type: ipc.TypeDesktopLocalICECandidate}
	if shouldForwardUnsolicitedHelperMessage(&Session{AllowedScopes: []string{"tray"}}, env) {
		t.Fatal("a helper without the desktop scope must not trickle desktop ICE candidates")
	}
	if !shouldForwardUnsolicitedHelperMessage(&Session{AllowedScopes: []string{"desktop"}}, env) {
		t.Fatal("a desktop-scoped helper's ICE candidates must be forwarded")
	}
}
