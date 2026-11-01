package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #8434 test 3: the console sat at the sign-in screen (Connected, no user)
// while Administrator was Active over RDP in session 2, and Connect Desktop
// still targeted the empty console.
func TestActiveRemoteSessionOverSignInConsole(t *testing.T) {
	signInConsole := sessionbroker.DetectedSession{Session: "1", State: "connected", Type: "console"}
	activeRDP := sessionbroker.DetectedSession{Session: "2", State: "active", Type: "rdp", Username: "Administrator"}
	all := func(string) bool { return true }
	none := func(string) bool { return false }

	for _, tc := range []struct {
		name     string
		console  string
		detected []sessionbroker.DetectedSession
		capable  func(string) bool
		want     string
	}{
		{"console at sign-in, active RDP with a helper", "1",
			[]sessionbroker.DetectedSession{signInConsole, activeRDP}, all, "2"},
		{"RDP session has no capable helper", "1",
			[]sessionbroker.DetectedSession{signInConsole, activeRDP}, none, ""},
		{"someone is signed in at the console", "1",
			[]sessionbroker.DetectedSession{{Session: "1", State: "active", Type: "console", Username: "alice"}, activeRDP}, all, ""},
		// A failed WTS username query is "could not tell", not "nobody".
		{"console username unknown", "1",
			[]sessionbroker.DetectedSession{{Session: "1", State: "connected", Type: "console", UsernameUnknown: true}, activeRDP}, all, ""},
		{"RDP session disconnected", "1",
			[]sessionbroker.DetectedSession{signInConsole, {Session: "2", State: "disconnected", Type: "rdp", Username: "Administrator"}}, all, ""},
		{"RDP session with no user yet", "1",
			[]sessionbroker.DetectedSession{signInConsole, {Session: "2", State: "active", Type: "rdp"}}, all, ""},
		{"active non-RDP session is not a remote session", "1",
			[]sessionbroker.DetectedSession{signInConsole, {Session: "2", State: "active", Type: "console", Username: "bob"}}, all, ""},
		{"console not enumerated", "1",
			[]sessionbroker.DetectedSession{activeRDP}, all, ""},
		// Terminal server: several signed-in RDP users. Picking one would be a
		// guess at whose desktop the technician meant.
		{"two active RDP users is ambiguous", "1",
			[]sessionbroker.DetectedSession{signInConsole,
				{Session: "2", State: "active", Type: "rdp", Username: "a"},
				{Session: "3", State: "active", Type: "rdp", Username: "b"}},
			all, ""},
		{"two active RDP users, only one with a helper, is still ambiguous", "1",
			[]sessionbroker.DetectedSession{signInConsole,
				{Session: "2", State: "active", Type: "rdp", Username: "a"},
				{Session: "3", State: "active", Type: "rdp", Username: "b"}},
			func(s string) bool { return s == "3" }, ""},
		{"a disconnected second RDP user does not make it ambiguous", "1",
			[]sessionbroker.DetectedSession{signInConsole, activeRDP,
				{Session: "3", State: "disconnected", Type: "rdp", Username: "b"}},
			all, "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := activeRemoteSessionOverSignInConsole(tc.console, tc.detected, tc.capable); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
