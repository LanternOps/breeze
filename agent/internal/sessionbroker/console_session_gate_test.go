package sessionbroker

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestRoleIdentityRejection(t *testing.T) {
	const nonSystemSID = "S-1-5-21-1-2-3-1001"

	tests := []struct {
		name                                    string
		role                                    ipc.HelperRole
		sid, peer, claimed, console, wantReason string
		wantReject                              bool
	}{
		{"RDP user matching kernel session", ipc.HelperRoleUser, nonSystemSID, "7", "7", "1", "", false},
		{"RDP user session mismatch", ipc.HelperRoleUser, nonSystemSID, "7", "8", "1", "user role session claim does not match peer token", true},
		{"RDP user unknown peer session", ipc.HelperRoleUser, nonSystemSID, "0", "7", "1", "user role requires an interactive peer session", true},
		{"SYSTEM cannot claim user", ipc.HelperRoleUser, systemSID, "7", "7", "1", "user role requires non-SYSTEM identity", true},
		{"non-SYSTEM cannot claim system", ipc.HelperRoleSystem, nonSystemSID, "7", "7", "1", "system role requires SYSTEM identity", true},
		{"SYSTEM matching RDP session", ipc.HelperRoleSystem, systemSID, "7", "7", "1", "", false},
		{"assist remains console bound", ipc.HelperRoleAssist, nonSystemSID, "7", "7", "1", "assist role requires the active console session", true},
		{"assist from console session accepted", ipc.HelperRoleAssist, nonSystemSID, "1", "1", "1", "", false},
		{"assist as SYSTEM rejected on SID", ipc.HelperRoleAssist, systemSID, "1", "1", "1", "assist role requires non-SYSTEM identity", true},
		{"assist rejected when console lookup failed (session 0 sentinel)", ipc.HelperRoleAssist, nonSystemSID, "0", "0", "0", "assist role requires the active console session", true},
		{"watchdog as SYSTEM unaffected by console session", ipc.HelperRoleWatchdog, systemSID, "0", "0", "1", "", false},
		{"watchdog as non-SYSTEM rejected", ipc.HelperRoleWatchdog, nonSystemSID, "1", "1", "1", "watchdog role requires SYSTEM identity", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason, rejected := roleIdentityRejection(
				tc.role, tc.sid, 0, tc.peer, tc.claimed, tc.console, "windows",
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
		ipc.HelperRoleUser, "", 1000, "99", "7", "1", "darwin",
	)
	if rejected {
		t.Fatalf("unix user role unexpectedly rejected: reason=%q", reason)
	}
}

func TestPreferredRunAsUserSessionIgnoresRDPHelper(t *testing.T) {
	now := time.Now()

	consoleUser, consoleClient := newTestUserSession(t, "console-user", "alice", now.Add(-20*time.Minute))
	defer consoleClient.Close()
	consoleUser.WinSessionID = "1"

	rdpUser, rdpClient := newTestUserSession(t, "rdp-user", "alice", now.Add(-time.Minute))
	defer rdpClient.Close()
	rdpUser.WinSessionID = "7"

	b := &Broker{
		sessions: map[string]*Session{
			consoleUser.SessionID: consoleUser,
			rdpUser.SessionID:     rdpUser,
		},
		byIdentity:         make(map[string][]*Session),
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != consoleUser {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %v, want physical-console helper %q", got, consoleUser.SessionID)
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
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil (no console helper)", got.SessionID)
	}
}

// TestPreferredRunAsUserSessionWarnsWhenConsoleBindingSuppressesDelivery is the
// observable-fallback contract for the still-open run_as_user slice of #1009.
//
// The console binding (TestPreferredRunAsUserSessionFiltersByConsoleSession)
// correctly refuses to deliver a run_as_user script to a co-logged-in user's
// helper in a non-console session. But on an unusual multi-session / RDS host —
// where the operator's helper genuinely lives outside the active console session
// (e.g. the physical console sits at the lock screen while the operator works
// over RDP) — that same binding silently drops delivery, and the caller then
// downgrades to local SYSTEM execution. That drop must be OBSERVABLE: when the
// only eligible run_as_user helpers are excluded purely because they are outside
// the console session, the broker must emit a clear WARN naming the suppression
// so the dropped delivery is diagnosable, rather than vanishing silently.
func TestPreferredRunAsUserSessionWarnsWhenConsoleBindingSuppressesDelivery(t *testing.T) {
	logs := captureLogs(t)

	now := time.Now()

	// A user-role run_as_user helper exists, but only in a NON-console session.
	otherUser, otherClient := newTestUserSession(t, "noncon-user", "alice", now.Add(-1*time.Minute))
	defer otherClient.Close()
	otherUser.WinSessionID = "3"

	b := &Broker{
		sessions: map[string]*Session{
			otherUser.SessionID: otherUser,
		},
		byIdentity:         make(map[string][]*Session),
		consoleSessionIDFn: func() string { return "1" },
	}

	got := b.preferredRunAsUserSessionForOS("windows")
	if got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil (no console helper)", got.SessionID)
	}

	out := logs.String()
	if !strings.Contains(out, "run_as_user delivery suppressed") {
		t.Fatalf("expected a WARN that run_as_user delivery was suppressed by console binding; got logs:\n%s", out)
	}
	// The warning must name the active console session and the count of
	// excluded non-console helpers so an operator can diagnose the RDS-host drop.
	if !strings.Contains(out, "consoleWinSession") || !strings.Contains(out, "excludedNonConsole") {
		t.Fatalf("suppression warning missing diagnostic fields; got logs:\n%s", out)
	}
}

// TestPreferredRunAsUserSessionWarnCountsAllExcludedHelpers asserts the WARN's
// excludedNonConsole field reflects the ACTUAL number of off-console helpers,
// not a hard-coded 1. This is the multi-RDP-session scenario: several
// co-logged-in users each have a run_as_user helper, all off the active console
// session. The operator needs the count to understand the scope of the drop.
func TestPreferredRunAsUserSessionWarnCountsAllExcludedHelpers(t *testing.T) {
	logs := captureLogs(t)

	now := time.Now()

	a, aClient := newTestUserSession(t, "noncon-a", "alice", now.Add(-3*time.Minute))
	defer aClient.Close()
	a.WinSessionID = "3"

	bSess, bClient := newTestUserSession(t, "noncon-b", "bob", now.Add(-2*time.Minute))
	defer bClient.Close()
	bSess.WinSessionID = "4"

	c, cClient := newTestUserSession(t, "noncon-c", "carol", now.Add(-1*time.Minute))
	defer cClient.Close()
	c.WinSessionID = "5"

	b := &Broker{
		sessions: map[string]*Session{
			a.SessionID:     a,
			bSess.SessionID: bSess,
			c.SessionID:     c,
		},
		byIdentity:         make(map[string][]*Session),
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil", got.SessionID)
	}

	if out := logs.String(); !strings.Contains(out, "excludedNonConsole=3") {
		t.Fatalf("expected excludedNonConsole=3 in suppression WARN; got logs:\n%s", out)
	}
}

// TestPreferredRunAsUserSessionWarnsWhenConsoleLookupFailed covers the
// fail-closed scenario: when the active-console-session lookup fails,
// ConsoleSessionID() normalizes the "0" sentinel to "". No helper has an empty
// WinSessionID, so every run_as_user helper is excluded and delivery is fully
// suppressed — exactly the case where the operator most needs the WARN (the
// console lookup itself is broken). It must fire with an empty consoleWinSession.
func TestPreferredRunAsUserSessionWarnsWhenConsoleLookupFailed(t *testing.T) {
	logs := captureLogs(t)

	now := time.Now()

	helper, helperClient := newTestUserSession(t, "some-user", "alice", now.Add(-1*time.Minute))
	defer helperClient.Close()
	helper.WinSessionID = "1"

	b := &Broker{
		sessions: map[string]*Session{
			helper.SessionID: helper,
		},
		byIdentity: make(map[string][]*Session),
		// "0" is the WTSGetActiveConsoleSessionId failure / Session-0 sentinel,
		// normalized to "" by ConsoleSessionID().
		consoleSessionIDFn: func() string { return "0" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil (console lookup failed)", got.SessionID)
	}

	out := logs.String()
	if !strings.Contains(out, "run_as_user delivery suppressed") {
		t.Fatalf("expected a suppression WARN when console lookup failed; got logs:\n%s", out)
	}
	if !strings.Contains(out, "excludedNonConsole=1") {
		t.Fatalf("expected excludedNonConsole=1 when console lookup failed; got logs:\n%s", out)
	}
}

// TestPreferredRunAsUserSessionNoWarnWhenNoUserHelper asserts the suppression
// warning is NOT noise: when there is genuinely no user-role run_as_user helper
// connected at all (so nil is the correct, expected result — not a console-binding
// drop), the broker must stay quiet rather than crying wolf on every poll.
func TestPreferredRunAsUserSessionNoWarnWhenNoUserHelper(t *testing.T) {
	logs := captureLogs(t)

	b := &Broker{
		sessions:           map[string]*Session{},
		byIdentity:         make(map[string][]*Session),
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != nil {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) = %q, want nil", got.SessionID)
	}

	if out := logs.String(); strings.Contains(out, "run_as_user delivery suppressed") {
		t.Fatalf("did not expect a suppression WARN when no user helper is connected; got logs:\n%s", out)
	}
}

// TestPreferredRunAsUserSessionNoWarnOnConsoleMatch asserts that the happy path —
// a helper IS present in the console session and is selected — logs no spurious
// suppression warning.
func TestPreferredRunAsUserSessionNoWarnOnConsoleMatch(t *testing.T) {
	logs := captureLogs(t)

	now := time.Now()

	consoleUser, consoleClient := newTestUserSession(t, "con-user", "alice", now.Add(-2*time.Minute))
	defer consoleClient.Close()
	consoleUser.WinSessionID = "1"

	// A co-logged-in non-console helper also present — it is excluded, but
	// because a console helper WAS selected, no suppression warning should fire.
	otherUser, otherClient := newTestUserSession(t, "noncon-user", "mallory", now.Add(-1*time.Minute))
	defer otherClient.Close()
	otherUser.WinSessionID = "3"

	b := &Broker{
		sessions: map[string]*Session{
			consoleUser.SessionID: consoleUser,
			otherUser.SessionID:   otherUser,
		},
		byIdentity:         make(map[string][]*Session),
		consoleSessionIDFn: func() string { return "1" },
	}

	if got := b.preferredRunAsUserSessionForOS("windows"); got != consoleUser {
		t.Fatalf("preferredRunAsUserSessionForOS(windows) did not select the console helper")
	}

	if out := logs.String(); strings.Contains(out, "run_as_user delivery suppressed") {
		t.Fatalf("did not expect a suppression WARN when a console helper was selected; got logs:\n%s", out)
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
