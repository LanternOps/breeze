package sessionbroker

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// TestRoleIdentityRejectionConsoleSessionBinding verifies the positive
// console-session assertion added for the assist/user IPC roles (#1009): on a
// multi-user Windows host, a non-SYSTEM peer in a non-console session that
// claims assist/user must be rejected, while the same role from the active
// console session is accepted. The SYSTEM/watchdog paths must be unchanged.
//
// The comparison is pure (peer WinSessionID vs active console session id), so it
// is fully table-testable on darwin without any Windows APIs.
func TestRoleIdentityRejectionConsoleSessionBinding(t *testing.T) {
	const nonSystemSID = "S-1-5-21-1-2-3-1001"

	cases := []struct {
		name           string
		role           string
		sid            string
		peerWinSession string
		consoleSession string
		wantReason     string
		wantReject     bool
	}{
		{
			name:           "assist from console session accepted",
			role:           ipc.HelperRoleAssist,
			sid:            nonSystemSID,
			peerWinSession: "1",
			consoleSession: "1",
			wantReject:     false,
		},
		{
			name:           "assist from non-console session rejected",
			role:           ipc.HelperRoleAssist,
			sid:            nonSystemSID,
			peerWinSession: "3",
			consoleSession: "1",
			wantReason:     "assist role requires the active console session",
			wantReject:     true,
		},
		{
			name:           "user from console session accepted",
			role:           ipc.HelperRoleUser,
			sid:            nonSystemSID,
			peerWinSession: "2",
			consoleSession: "2",
			wantReject:     false,
		},
		{
			name:           "user from non-console session rejected",
			role:           ipc.HelperRoleUser,
			sid:            nonSystemSID,
			peerWinSession: "2",
			consoleSession: "1",
			wantReason:     "user role requires the active console session",
			wantReject:     true,
		},
		{
			// SYSTEM is gated by SID only and must be unaffected by the
			// console-session binding regardless of which session it runs in.
			name:           "system role unaffected by console session",
			role:           ipc.HelperRoleSystem,
			sid:            systemSID,
			peerWinSession: "0",
			consoleSession: "1",
			wantReject:     false,
		},
		{
			name:           "watchdog role unaffected by console session",
			role:           ipc.HelperRoleWatchdog,
			sid:            systemSID,
			peerWinSession: "0",
			consoleSession: "1",
			wantReject:     false,
		},
		{
			// Existing SID gate still fires before the console check.
			name:           "assist as SYSTEM still rejected on SID",
			role:           ipc.HelperRoleAssist,
			sid:            systemSID,
			peerWinSession: "1",
			consoleSession: "1",
			wantReason:     "assist role requires non-SYSTEM identity",
			wantReject:     true,
		},
		{
			// Defensive: an unknown/empty console session id must not silently
			// admit assist/user from an arbitrary session.
			name:           "assist rejected when console session unknown",
			role:           ipc.HelperRoleAssist,
			sid:            nonSystemSID,
			peerWinSession: "1",
			consoleSession: "",
			wantReason:     "assist role requires the active console session",
			wantReject:     true,
		},
		{
			// Fail-closed: GetConsoleSessionID() returns "0" when
			// WTSGetActiveConsoleSessionId fails (API returns 0xFFFFFFFF). A peer
			// whose kernel session is also "0" (Session-0 services) must NOT be
			// admitted just because peer == console == "0" — "0" is not a valid
			// interactive console session (#1009 review fail-closed hole).
			name:           "assist rejected when console lookup failed (session 0 sentinel)",
			role:           ipc.HelperRoleAssist,
			sid:            nonSystemSID,
			peerWinSession: "0",
			consoleSession: "0",
			wantReason:     "assist role requires the active console session",
			wantReject:     true,
		},
		{
			name:           "user rejected when console lookup failed (session 0 sentinel)",
			role:           ipc.HelperRoleUser,
			sid:            nonSystemSID,
			peerWinSession: "0",
			consoleSession: "0",
			wantReason:     "user role requires the active console session",
			wantReject:     true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason, rejected := roleIdentityRejection(
				tc.role, tc.sid, 0, tc.peerWinSession, tc.consoleSession, "windows",
			)
			if rejected != tc.wantReject {
				t.Fatalf("rejected = %v, want %v (reason %q)", rejected, tc.wantReject, reason)
			}
			if reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", reason, tc.wantReason)
			}
		})
	}
}

// TestRoleIdentityRejectionUnixUnchangedByConsoleBinding asserts that the
// console-session binding is a Windows-only concept: on Unix, assist/user have
// no per-session console gate (the macOS desktop helper authenticates as
// user-role from the GUI/loginwindow session). Passing mismatched session ids
// must NOT cause a rejection on goos != windows.
func TestRoleIdentityRejectionUnixUnchangedByConsoleBinding(t *testing.T) {
	reason, rejected := roleIdentityRejection(
		ipc.HelperRoleUser, "", 1000, "99", "1", "darwin",
	)
	if rejected {
		t.Fatalf("unix user role unexpectedly rejected: reason=%q", reason)
	}
}

// TestPreferredRunAsUserSessionFiltersByConsoleSession verifies that
// run_as_user routing only ever selects a helper in the active console session,
// never a co-logged-in user's helper in another session (#1009). A newer helper
// in a non-console session must be ignored in favour of the console helper, even
// though it is more recent.
func TestPreferredRunAsUserSessionFiltersByConsoleSession(t *testing.T) {
	now := time.Now()

	consoleUser, consoleClient := newTestUserSession(t, "console-user", "alice", now.Add(-20*time.Minute))
	defer consoleClient.Close()
	consoleUser.WinSessionID = "1"

	// Co-logged-in attacker session — newer, so it would win a naive
	// "newest user helper" selection.
	otherUser, otherClient := newTestUserSession(t, "other-user", "mallory", now.Add(-1*time.Minute))
	defer otherClient.Close()
	otherUser.WinSessionID = "3"

	b := &Broker{
		sessions: map[string]*Session{
			consoleUser.SessionID: consoleUser,
			otherUser.SessionID:   otherUser,
		},
		byIdentity:         make(map[string][]*Session),
		staleHelpers:       make(map[string][]int),
		consoleSessionIDFn: func() string { return "1" },
	}

	// Drive the Windows code path explicitly; the console-session filter is a
	// Windows multi-user (RDS/terminal-server) concept.
	got := b.preferredRunAsUserSessionForOS("windows")
	if got != consoleUser {
		var gotID string
		if got != nil {
			gotID = got.SessionID
		}
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want console session %q", gotID, consoleUser.SessionID)
	}

	// On non-Windows the console filter does not apply: the newest user helper
	// wins as before (otherUser is newer).
	if got := b.preferredRunAsUserSessionForOS("darwin"); got != otherUser {
		t.Fatalf("preferredRunAsUserSessionForOS(darwin) selected the wrong session")
	}
}

// TestPreferredRunAsUserSessionNoConsoleHelper asserts that when no helper is in
// the active console session, run_as_user routing selects nothing rather than
// falling back to a helper in another (attacker-controlled) session.
func TestPreferredRunAsUserSessionNoConsoleHelper(t *testing.T) {
	now := time.Now()

	otherUser, otherClient := newTestUserSession(t, "other-user", "mallory", now.Add(-1*time.Minute))
	defer otherClient.Close()
	otherUser.WinSessionID = "3"

	b := &Broker{
		sessions: map[string]*Session{
			otherUser.SessionID: otherUser,
		},
		byIdentity:         make(map[string][]*Session),
		staleHelpers:       make(map[string][]int),
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil (no console helper)", got.SessionID)
	}
}

// TestConsoleSessionIDDefaultsToGetConsoleSessionID verifies the broker's
// console-session seam defaults to the platform GetConsoleSessionID() when no
// override is injected (the production path), and honours the override when set
// (the test path). On darwin GetConsoleSessionID() returns "1".
func TestConsoleSessionIDSeam(t *testing.T) {
	b := New("/tmp/does-not-matter.sock", nil)
	if got := b.ConsoleSessionID(); got != GetConsoleSessionID() {
		t.Fatalf("default ConsoleSessionID() = %q, want %q", got, GetConsoleSessionID())
	}

	b.consoleSessionIDFn = func() string { return "7" }
	if got := b.ConsoleSessionID(); got != "7" {
		t.Fatalf("overridden ConsoleSessionID() = %q, want %q", got, "7")
	}

	// "0" (Session-0 services sentinel / WTS-failure value) is normalized to ""
	// so every consumer fails closed for the assist/user binding (#1009).
	b.consoleSessionIDFn = func() string { return "0" }
	if got := b.ConsoleSessionID(); got != "" {
		t.Fatalf("ConsoleSessionID() with session-0 sentinel = %q, want \"\"", got)
	}
}
