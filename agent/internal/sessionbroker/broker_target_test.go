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
