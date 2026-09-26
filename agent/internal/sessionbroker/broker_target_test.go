package sessionbroker

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// addTestSession registers a connected helper session directly in broker
// state, mirroring the register-then-publish pattern used by
// TestSnapshotReadAfterWrite: a Broker built via New() serves reads
// (including FindCapableSession) from an atomic snapshot, so a direct write
// to b.sessions is invisible until publishSnapshotLocked() runs under the
// same lock.
//
// winSession/role pairs must be unique per test since they form the session
// map key (mirrors real registration, which keys by SessionID).
func addTestSession(b *Broker, winSession string, role ipc.HelperRole, scopes []string, caps *ipc.Capabilities) *Session {
	now := time.Now()
	s := &Session{
		SessionID:     winSession + "/" + string(role),
		WinSessionID:  winSession,
		HelperRole:    role,
		AllowedScopes: scopes,
		Capabilities:  caps,
		ConnectedAt:   now,
		LastSeen:      now,
	}
	b.mu.Lock()
	b.sessions[s.SessionID] = s
	b.publishSnapshotLocked()
	b.mu.Unlock()
	return s
}

func TestSessionWithScopeInWinSession(t *testing.T) {
	b := New("scope-target", nil)
	other := addTestSession(b, "2", ipc.HelperRoleUser, []string{"notify", "consent_ui_fallback"}, nil)
	want := addTestSession(b, "3", ipc.HelperRoleUser, []string{"notify", "consent_ui_fallback"}, nil)

	if got := b.SessionWithScopeInWinSession("consent_ui_fallback", "3"); got != want {
		t.Fatalf("expected session in win session 3, got %+v", got)
	}
	if got := b.SessionWithScopeInWinSession("consent_ui_fallback", "9"); got != nil {
		t.Fatalf("expected nil for absent session, got %+v", got)
	}
	if got := b.SessionWithScopeInWinSession("pam", "2"); got != nil {
		t.Fatalf("expected nil for scope not held, got %+v", got)
	}
	_ = other
}

func TestFindCapableSessionExplicitTargetSkipsDisconnected(t *testing.T) {
	old := isSessionDisconnectedFn
	isSessionDisconnectedFn = func(winSessionID string) bool { return winSessionID == "3" }
	defer func() { isSessionDisconnectedFn = old }()

	b := New("target-disconnected", nil)
	addTestSession(b, "3", ipc.HelperRoleSystem, []string{"desktop"}, &ipc.Capabilities{CanCapture: true})

	// Explicit target in a disconnected session: pass 1 must now reject it.
	if got := b.FindCapableSession("capture", "3"); got != nil {
		t.Fatalf("explicit target in disconnected session must not match, got %+v", got)
	}
}

func TestFindCapableSessionUntargetedUnchanged(t *testing.T) {
	old := isSessionDisconnectedFn
	isSessionDisconnectedFn = func(string) bool { return false }
	defer func() { isSessionDisconnectedFn = old }()

	b := New("untargeted", nil)
	console := GetConsoleSessionID()
	want := addTestSession(b, console, ipc.HelperRoleSystem, []string{"desktop"}, &ipc.Capabilities{CanCapture: true})

	if got := b.FindCapableSession("capture", ""); got != want {
		t.Fatalf("untargeted lookup must still resolve console, got %+v", got)
	}
}

// TestNotifySessionInWinSessionPrefersUserRole is the #6864 regression guard.
// On an RDSH host the targeted session holds BOTH a system-role helper (the
// capture helper, streaming the desktop and so touched on every frame) and a
// user-role helper. SessionWithScopeInWinSession ranks by LastSeen, so it handed
// the session notice to the system-role helper, whose toast runs as SYSTEM and
// fails (E_ACCESSDENIED / "notification platform is unavailable"). The notice
// must go to the helper running as the signed-in user.
func TestNotifySessionInWinSessionPrefersUserRole(t *testing.T) {
	b := New("notify-target-role", nil)
	user := addTestSession(b, "3", ipc.HelperRoleUser, []string{"notify", "clipboard", "run_as_user"}, nil)
	system := addTestSession(b, "3", ipc.HelperRoleSystem, []string{"notify", "tray", "clipboard", "desktop"}, nil)
	// The capture helper is the one the broker heard from most recently.
	system.LastSeen = user.LastSeen.Add(5 * time.Second)
	system.ConnectedAt = user.ConnectedAt.Add(5 * time.Second)
	addTestSession(b, "5", ipc.HelperRoleUser, []string{"notify"}, nil)

	if got := b.NotifySessionInWinSession("3"); got != user {
		t.Fatalf("notice must go to the user-role helper, got %+v", got)
	}
}

func TestNotifySessionInWinSessionSystemFallbackAndStrictness(t *testing.T) {
	b := New("notify-target-fallback", nil)
	system := addTestSession(b, "3", ipc.HelperRoleSystem, []string{"notify", "desktop"}, nil)
	addTestSession(b, "4", ipc.HelperRoleAssist, []string{ipc.ScopeConsentUI}, nil)
	addTestSession(b, "5", ipc.HelperRoleUser, []string{"notify"}, nil)

	// No user-role helper in the session: the system-role helper is the only
	// thing that can draw there, so it is still used (the helper falls back to a
	// dialog when its toast fails).
	if got := b.NotifySessionInWinSession("3"); got != system {
		t.Fatalf("expected the system-role helper as fallback, got %+v", got)
	}
	// A helper without the notify scope is never chosen.
	if got := b.NotifySessionInWinSession("4"); got != nil {
		t.Fatalf("a helper without the notify scope must not be chosen, got %+v", got)
	}
	// Strict: never another Windows session's helper.
	if got := b.NotifySessionInWinSession("9"); got != nil {
		t.Fatalf("expected nil for a session with no helper, got %+v", got)
	}
	if got := b.NotifySessionInWinSession(""); got != nil {
		t.Fatalf("empty target must not match, got %+v", got)
	}
}
