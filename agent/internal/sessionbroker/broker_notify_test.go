package sessionbroker

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// notifyProbe is one connected helper session plus the client end of its
// socket, so a test can observe exactly what the broker put on the wire.
type notifyProbe struct {
	name    string
	session *Session
	client  *ipc.Conn
}

// newNotifyProbe registers a session with the given scopes in the broker and
// returns a handle for reading what the broker sends it.
func newNotifyProbe(t *testing.T, b *Broker, name string, scopes []string) *notifyProbe {
	t.Helper()

	serverConn, clientConn := createSocketPair(t)
	t.Cleanup(func() { _ = clientConn.Close() })

	session := NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "", name, scopes)
	t.Cleanup(func() { _ = session.Close() })

	b.mu.Lock()
	b.sessions[session.SessionID] = session
	b.publishSnapshotLocked()
	b.mu.Unlock()

	return &notifyProbe{name: name, session: session, client: ipc.NewConn(clientConn)}
}

// gotNotification reports whether the broadcast reached this probe.
//
// It does NOT wait on a timeout to prove a negative — that would make the
// "filtered out" case a race against an arbitrary sleep. Instead the caller
// pushes a sentinel of a different type down every session AFTER the
// broadcast; because a session's writes are ordered, reading the first
// envelope is decisive: TypeNotify means delivered, the sentinel means the
// broadcast was filtered out.
func (p *notifyProbe) gotNotification(t *testing.T) bool {
	t.Helper()

	env, err := p.client.Recv()
	if err != nil {
		t.Fatalf("%s: recv: %v", p.name, err)
	}
	switch env.Type {
	case ipc.TypeNotify:
		return true
	case notifySentinelType:
		return false
	default:
		t.Fatalf("%s: unexpected message type %q", p.name, env.Type)
		return false
	}
}

// notifySentinelType is a message type BroadcastNotification never sends, so
// its arrival proves the broadcast was not queued ahead of it.
const notifySentinelType = ipc.TypePong

func TestBroadcastNotificationFiltersOnNotifyScope(t *testing.T) {
	tests := []struct {
		name   string
		scopes []string
		want   bool
	}{
		{
			name:   "system helper scopes",
			scopes: systemHelperScopes,
			want:   true,
		},
		{
			name:   "user helper scopes",
			scopes: userHelperScopes,
			want:   true,
		},
		{
			name:   "notify only",
			scopes: []string{"notify"},
			want:   true,
		},
		{
			// The Breeze Assist (Tauri) helper: assist/consent_ui, no notify.
			// Its session loop has no handler for TypeNotify at all.
			name:   "assist helper scopes",
			scopes: assistHelperScopes,
			want:   false,
		},
		{
			name:   "watchdog helper scopes",
			scopes: watchdogHelperScopes,
			want:   false,
		},
		{
			name:   "desktop and clipboard without notify",
			scopes: []string{"desktop", "clipboard"},
			want:   false,
		},
		{
			// The macOS desktop helper: scopesForRole has granted it "desktop"
			// plus "notify" since #3197, because the cross-platform reboot
			// warning ladder broadcasts through here and this helper is the
			// only thing that can render a toast for a logged-in macOS user.
			// TestMacDesktopHelperScopesGrantNotify pins the grant itself;
			// this case pins that the filter honours it.
			name:   "macos desktop helper scopes",
			scopes: macDesktopHelperScopes,
			want:   true,
		},
		{
			// The pre-#3197 macOS grant, kept as a regression case: a helper
			// holding "desktop" alone is still filtered out, so the fix was a
			// widened grant and not a weakened filter.
			name:   "desktop without notify is still filtered",
			scopes: []string{"desktop"},
			want:   false,
		},
		{
			name:   "no scopes",
			scopes: nil,
			want:   false,
		},
		{
			// HasScope treats "*" as holding every scope; the broadcast must
			// follow that same rule rather than string-matching "notify".
			name:   "wildcard scope",
			scopes: []string{"*"},
			want:   true,
		},
	}

	b := New("broadcast-notify-scope", nil)

	probes := make([]*notifyProbe, 0, len(tests))
	for _, tt := range tests {
		probes = append(probes, newNotifyProbe(t, b, tt.name, tt.scopes))
	}

	b.BroadcastNotification("Reboot required", "Your device will restart", "critical")

	// Sentinel after the broadcast — see gotNotification.
	for _, p := range probes {
		if err := p.session.SendNotify("sentinel", notifySentinelType, nil); err != nil {
			t.Fatalf("%s: send sentinel: %v", p.name, err)
		}
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := probes[i].gotNotification(t); got != tt.want {
				t.Errorf("scopes %v: received notification = %v, want %v", tt.scopes, got, tt.want)
			}
		})
	}
}

// TestBroadcastNotificationPayload guards the payload the scoped sessions
// actually receive, so the filter change cannot quietly corrupt the message.
func TestBroadcastNotificationPayload(t *testing.T) {
	b := New("broadcast-notify-payload", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})

	b.BroadcastNotification("Reboot required", "Your device will restart in 5 minutes", "critical")

	env, err := p.client.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if env.Type != ipc.TypeNotify {
		t.Fatalf("env.Type = %q, want %q", env.Type, ipc.TypeNotify)
	}

	var req ipc.NotifyRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if req.Title != "Reboot required" {
		t.Errorf("Title = %q, want %q", req.Title, "Reboot required")
	}
	if req.Body != "Your device will restart in 5 minutes" {
		t.Errorf("Body = %q, want %q", req.Body, "Your device will restart in 5 minutes")
	}
	if req.Urgency != "critical" {
		t.Errorf("Urgency = %q, want %q", req.Urgency, "critical")
	}
}

// TestBroadcastNotificationContinuesPastSendFailure proves one session's dead
// transport cannot starve its siblings. The broadcast loop logs and moves on
// rather than aborting, so a helper that died between the snapshot and the
// send does not silently swallow everyone else's notification.
func TestBroadcastNotificationContinuesPastSendFailure(t *testing.T) {
	b := New("broadcast-notify-send-failure", nil)

	// Registered first so it is a candidate, then killed: SendNotify will fail
	// on a closed transport. Map iteration order is random, so this exercises
	// the failure both before and after the healthy session across runs.
	dead := newNotifyProbe(t, b, "dead-session", []string{"notify"})
	if err := dead.session.Close(); err != nil {
		t.Fatalf("close dead session: %v", err)
	}
	// Guards the test against passing vacuously: if a closed transport still
	// accepted writes, the broadcast would never enter the error branch.
	if err := dead.session.SendNotify("", ipc.TypeNotify, &ipc.NotifyRequest{}); err == nil {
		t.Fatal("send on a closed session succeeded; the failure path is not being exercised")
	}

	healthy := newNotifyProbe(t, b, "healthy-session", []string{"notify"})

	b.BroadcastNotification("Reboot required", "Your device will restart", "critical")

	if err := healthy.session.SendNotify("sentinel", notifySentinelType, nil); err != nil {
		t.Fatalf("healthy session: send sentinel: %v", err)
	}
	if !healthy.gotNotification(t) {
		t.Error("healthy session missed the notification because a sibling's send failed")
	}
}

// TestBroadcastNotificationSkipsSessionsWithoutNotifyScopeEntirely is the
// regression guard for #3255 in its bluntest form: with only non-notify
// sessions connected, the broker must put nothing on any wire.
func TestBroadcastNotificationSkipsSessionsWithoutNotifyScopeEntirely(t *testing.T) {
	b := New("broadcast-notify-none", nil)
	assist := newNotifyProbe(t, b, "assist", assistHelperScopes)
	watchdog := newNotifyProbe(t, b, "watchdog", watchdogHelperScopes)

	b.BroadcastNotification("Reboot required", "Your device will restart", "critical")

	for _, p := range []*notifyProbe{assist, watchdog} {
		if err := p.session.SendNotify("sentinel", notifySentinelType, nil); err != nil {
			t.Fatalf("%s: send sentinel: %v", p.name, err)
		}
		if p.gotNotification(t) {
			t.Errorf("%s (scopes %v) received a notification it cannot render", p.name, p.session.AllowedScopes)
		}
	}
}

// TestMacDesktopHelperScopesGrantNotify pins the #3197 grant itself. The macOS
// desktop helper is the only process that can render a toast for a logged-in
// macOS user, and RebootManager is cross-platform now, so losing "notify" here
// would silently reproduce the original defect on macOS. scopesForRole's darwin
// branch cannot be called directly in a unit test (it verifies the peer's
// resolved binary path against the running executable's trusted set), so the
// grant is pinned through the named slice it returns.
func TestMacDesktopHelperScopesGrantNotify(t *testing.T) {
	var hasNotify, hasDesktop bool
	for _, s := range macDesktopHelperScopes {
		switch s {
		case "notify":
			hasNotify = true
		case "desktop":
			hasDesktop = true
		}
	}
	if !hasNotify {
		t.Error("macDesktopHelperScopes is missing \"notify\" — a macOS reboot warning would reach nobody (#3197)")
	}
	if !hasDesktop {
		t.Error("macDesktopHelperScopes is missing \"desktop\"")
	}
	// Still narrower than the full user helper: no run_as_user, no clipboard.
	for _, s := range macDesktopHelperScopes {
		if s == "run_as_user" || s == "clipboard" {
			t.Errorf("macDesktopHelperScopes unexpectedly widened to include %q", s)
		}
	}
}
