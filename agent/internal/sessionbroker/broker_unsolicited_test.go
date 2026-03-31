package sessionbroker

import (
	"testing"

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
