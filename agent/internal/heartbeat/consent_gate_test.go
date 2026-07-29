package heartbeat

// Tests for per-Windows-session consent/notify/banner routing (Task 4). The
// defect being fixed: consentUISession (now consentUISessionForTarget) and
// the notify/banner senders used
// machine-global PreferredSessionWithScope, so on a multi-session host the
// consent prompt (or banner) could land in a DIFFERENT user's session than
// the one actually being shadowed. These tests pin the strict, session-scoped
// resolution: a non-empty target must resolve to that Windows session's
// helper or nil — never another session's.

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// registerConsentTestSession registers a fake helper session directly into
// the broker's unexported session maps, mirroring the reflect-based
// getUnexportedField/setUnexportedField mechanism newTestBrokerWithSessions
// already uses in test_helpers_test.go. PreferredSessionWithScope and
// SessionWithScopeInWinSession both read b.sessions directly under RLock (not
// from the published snapshot), so this direct-write approach is sufficient
// without needing an exported test-only hook in package sessionbroker.
func registerConsentTestSession(t *testing.T, b *sessionbroker.Broker, winSession string, role ipc.HelperRole, scopes []string) *sessionbroker.Session {
	t.Helper()

	now := time.Now()
	s := &sessionbroker.Session{
		SessionID:     "consent-test-" + winSession + "-" + string(role) + "-" + time.Now().Format("150405.000000000"),
		WinSessionID:  winSession,
		HelperRole:    role,
		AllowedScopes: scopes,
		ConnectedAt:   now,
		LastSeen:      now,
	}

	sessions, _ := getUnexportedField(t, b, "sessions").(map[string]*sessionbroker.Session)
	if sessions == nil {
		sessions = make(map[string]*sessionbroker.Session)
	}
	sessions[s.SessionID] = s
	setUnexportedField(t, b, "sessions", sessions)

	byIdentity, _ := getUnexportedField(t, b, "byIdentity").(map[string][]*sessionbroker.Session)
	if byIdentity == nil {
		byIdentity = make(map[string][]*sessionbroker.Session)
	}
	byIdentity[s.IdentityKey] = append(byIdentity[s.IdentityKey], s)
	setUnexportedField(t, b, "byIdentity", byIdentity)

	return s
}

// TestConsentUISessionForTarget verifies consentUISessionForTarget resolves
// strictly within the given Windows session, never falling back to another
// session's helper, while an empty target keeps the legacy machine-global
// selection.
func TestConsentUISessionForTarget(t *testing.T) {
	b := sessionbroker.New("consent-target", nil)
	h := &Heartbeat{sessionBroker: b}

	// user helper with native-dialog fallback in win session 3, another in 5
	s3 := registerConsentTestSession(t, b, "3", ipc.HelperRoleUser, []string{"notify", ipc.ScopeConsentUIFallback})
	s5 := registerConsentTestSession(t, b, "5", ipc.HelperRoleUser, []string{"notify", ipc.ScopeConsentUIFallback})

	if got := h.consentUISessionForTarget("3"); got != s3 {
		t.Fatalf("target 3 must resolve session 3's helper, got %+v", got)
	}
	if got := h.consentUISessionForTarget("5"); got != s5 {
		t.Fatalf("target 5 must resolve session 5's helper, got %+v", got)
	}
	// Strictness: target with no consent-capable helper => nil (never another session's UI)
	if got := h.consentUISessionForTarget("9"); got != nil {
		t.Fatalf("target 9 has no helper; must be nil, got %+v", got)
	}
	// Legacy: empty target falls back to the machine-global preference
	if got := h.consentUISessionForTarget(""); got == nil {
		t.Fatalf("empty target must keep legacy global selection")
	}
}

// TestConsentUISessionForTarget_PrefersAssistOverFallbackInSameSession
// verifies that within a single targeted Windows session, an assist helper
// (ScopeConsentUI) is preferred over a fallback-only user helper
// (ScopeConsentUIFallback), matching the untargeted preference order.
func TestConsentUISessionForTarget_PrefersAssistOverFallbackInSameSession(t *testing.T) {
	b := sessionbroker.New("consent-target-prefer", nil)
	h := &Heartbeat{sessionBroker: b}

	fallback := registerConsentTestSession(t, b, "3", ipc.HelperRoleUser, []string{ipc.ScopeConsentUIFallback})
	assist := registerConsentTestSession(t, b, "3", ipc.HelperRoleAssist, []string{ipc.ScopeConsentUI})

	if got := h.consentUISessionForTarget("3"); got != assist {
		t.Fatalf("expected assist helper preferred over fallback in same session, got %+v (fallback=%+v)", got, fallback)
	}
}

// TestSessionWithScopeForTarget_EmptyTargetIsLegacyGlobal verifies that
// sessionWithScopeForTarget with an empty target delegates to the exact same
// machine-global PreferredSessionWithScope selection as before this change —
// the bit-identical-on-workstations contract.
func TestSessionWithScopeForTarget_EmptyTargetIsLegacyGlobal(t *testing.T) {
	b := sessionbroker.New("consent-legacy", nil)
	h := &Heartbeat{sessionBroker: b}

	want := registerConsentTestSession(t, b, "2", ipc.HelperRoleUser, []string{"notify"})

	if got := h.sessionWithScopeForTarget("notify", ""); got != want {
		t.Fatalf("empty target must match PreferredSessionWithScope, got %+v want %+v", got, want)
	}
}

// TestSessionWithScopeForTarget_NonEmptyTargetIsStrict verifies a non-empty
// target never falls back to a different Windows session, even when that
// other session is the only one holding the scope.
func TestSessionWithScopeForTarget_NonEmptyTargetIsStrict(t *testing.T) {
	b := sessionbroker.New("consent-strict", nil)
	h := &Heartbeat{sessionBroker: b}

	registerConsentTestSession(t, b, "7", ipc.HelperRoleUser, []string{"notify"})

	if got := h.sessionWithScopeForTarget("notify", "8"); got != nil {
		t.Fatalf("target session 8 has no notify-capable helper; must be nil, got %+v", got)
	}
}

// TestSetDesktopTargetRoundTrip verifies setDesktopTarget/takeDesktopTarget
// round-trip and that take clears the entry (stop path consumes it once).
func TestSetDesktopTargetRoundTrip(t *testing.T) {
	h := &Heartbeat{}

	h.setDesktopTarget("sess-1", "4")
	if got := h.takeDesktopTarget("sess-1"); got != "4" {
		t.Fatalf("takeDesktopTarget = %q, want %q", got, "4")
	}
	// Second take must see it cleared (legacy "" behavior).
	if got := h.takeDesktopTarget("sess-1"); got != "" {
		t.Fatalf("takeDesktopTarget after consumption = %q, want empty", got)
	}
}

// TestSetDesktopTargetRoundTrip_Empty verifies that an untargeted (legacy)
// connect records/returns "" rather than panicking on a nil map.
func TestSetDesktopTargetRoundTrip_Empty(t *testing.T) {
	h := &Heartbeat{}

	if got := h.takeDesktopTarget("never-set"); got != "" {
		t.Fatalf("takeDesktopTarget on unset session = %q, want empty", got)
	}

	h.setDesktopTarget("sess-legacy", "")
	if got := h.takeDesktopTarget("sess-legacy"); got != "" {
		t.Fatalf("takeDesktopTarget for untargeted session = %q, want empty", got)
	}
}
