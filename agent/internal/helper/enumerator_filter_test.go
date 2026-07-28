package helper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestConsoleOnlySessions(t *testing.T) {
	tests := []struct {
		name      string
		detected  []sessionbroker.DetectedSession
		consoleID string
		wantKeys  []string
	}{
		{
			name: "console session active is returned",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "active", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "rdp sessions are excluded even when active",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "active", Type: "console"},
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
				{Session: "4", Username: "carol", State: "active", Type: "rdp"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "console session in disconnected state is excluded",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "disconnected", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  nil,
		},
		{
			name: "connected (lock screen) console session is included",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "connected", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "sentinel console id 0 yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "0",
			wantKeys:  nil,
		},
		{
			name: "empty console id yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "",
			wantKeys:  nil,
		},
		{
			name: "console session absent from snapshot yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "2",
			wantKeys:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := consoleOnlySessions(tt.detected, tt.consoleID)
			if len(got) != len(tt.wantKeys) {
				t.Fatalf("got %d sessions, want %d (%v)", len(got), len(tt.wantKeys), got)
			}
			for i, want := range tt.wantKeys {
				if got[i].Key != want {
					t.Errorf("session[%d].Key = %q, want %q", i, got[i].Key, want)
				}
			}
		})
	}
}
