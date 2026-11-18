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
		// #10379: hand-written snapshots in the shape listSessionsCounted builds
		// from WTSEnumerateSessions + WTSQuerySessionInformation, not captured
		// from a host. Assist may only launch into a console session a user is
		// signed in to.
		{
			name: "#10379 nobody signed in: logon-screen console session is excluded",
			detected: []sessionbroker.DetectedSession{
				{Session: "0", Username: "", State: "disconnected", Type: "services"},
				{Session: "1", Username: "", State: "connected", Type: "console"},
			},
			consoleID: "1",
			wantKeys:  nil,
		},
		{
			name: "#10379 same host after a user signs in at the console",
			detected: []sessionbroker.DetectedSession{
				{Session: "0", Username: "", State: "disconnected", Type: "services"},
				{Session: "1", Username: "alice", State: "active", Type: "console"},
			},
			consoleID: "1",
			wantKeys:  []string{"1"},
		},
		{
			name: "active console session with no user name is excluded",
			detected: []sessionbroker.DetectedSession{
				{Session: "1", Username: "", State: "active", Type: "console"},
			},
			consoleID: "1",
			wantKeys:  nil,
		},
		{
			// "Could not tell" is not "nobody is signed in" (DetectedSession
			// contract). Excluding it would make Apply's stale loop stop a
			// running Assist on one failed WTS query; a launch is still gated
			// by the user-token-only spawn path.
			name: "console session whose user name could not be read stays eligible",
			detected: []sessionbroker.DetectedSession{
				{Session: "1", Username: "", UsernameUnknown: true, State: "active", Type: "console"},
			},
			consoleID: "1",
			wantKeys:  []string{"1"},
		},
		{
			name: "a locked session still has its user signed in",
			detected: []sessionbroker.DetectedSession{
				{Session: "1", Username: "alice", State: "active", Type: "console", Locked: true, LockKnown: true},
			},
			consoleID: "1",
			wantKeys:  []string{"1"},
		},
		{
			name: "fast user switch: only the new console user's session",
			detected: []sessionbroker.DetectedSession{
				{Session: "0", Username: "", State: "disconnected", Type: "services"},
				{Session: "1", Username: "alice", State: "disconnected", Type: "console"},
				{Session: "2", Username: "bob", State: "active", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "fast user switch to the logon screen: nobody on the console yet",
			detected: []sessionbroker.DetectedSession{
				{Session: "0", Username: "", State: "disconnected", Type: "services"},
				{Session: "1", Username: "alice", State: "disconnected", Type: "console"},
				{Session: "3", Username: "", State: "connected", Type: "console"},
			},
			consoleID: "3",
			wantKeys:  nil,
		},
		{
			// Pins the early guard: hasSignedInUser alone would admit this row.
			name: "session 0 is never eligible even when reported as the console",
			detected: []sessionbroker.DetectedSession{
				{Session: "0", Username: "SYSTEM", State: "active", Type: "services"},
			},
			consoleID: "0",
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
