package heartbeat

import (
	"bytes"
	"strings"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
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
		// A second active RDP session whose user could not be read may be a
		// second signed-in user: picking the other one would be a guess.
		{"active RDP session with an unreadable username is ambiguous", "1",
			[]sessionbroker.DetectedSession{signInConsole, activeRDP,
				{Session: "3", State: "active", Type: "rdp", UsernameUnknown: true}},
			all, ""},
		{"only an unreadable-username RDP session keeps the console", "1",
			[]sessionbroker.DetectedSession{signInConsole,
				{Session: "2", State: "active", Type: "rdp", UsernameUnknown: true}},
			all, ""},
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

// An active RDP session whose username could not be read keeps the console,
// and that has to be explained in the log: otherwise a technician who expected
// the RDP desktop has no record of why it was passed over (#8434 review). The
// Warn names the session and carries the WTS query's Win32 code.
func TestActiveRemoteSessionOverSignInConsoleLogsUnreadableUsername(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	signInConsole := sessionbroker.DetectedSession{Session: "1", State: "connected", Type: "console"}
	unreadable := sessionbroker.DetectedSession{Session: "3", State: "active", Type: "rdp",
		UsernameUnknown: true, UsernameErr: syscall.Errno(5)}
	if got := activeRemoteSessionOverSignInConsole("1", []sessionbroker.DetectedSession{signInConsole, unreadable},
		func(string) bool { return true }); got != "" {
		t.Fatalf("got %q, want the console kept", got)
	}
	out := buf.String()
	for _, want := range []string{"level=WARN", "username unreadable; keeping the sign-in console", "winSession=3", "consoleID=1", "win32Error=5"} {
		if !strings.Contains(out, want) {
			t.Errorf("log missing %q:\n%s", want, out)
		}
	}

	// No unreadable RDP session: nothing to explain.
	buf.Reset()
	activeRemoteSessionOverSignInConsole("1", []sessionbroker.DetectedSession{signInConsole,
		{Session: "2", State: "active", Type: "rdp", Username: "Administrator"}}, func(string) bool { return true })
	if strings.Contains(buf.String(), "username unreadable") {
		t.Errorf("logged an unreadable username with none present:\n%s", buf.String())
	}
}
