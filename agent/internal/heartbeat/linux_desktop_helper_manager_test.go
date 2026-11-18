package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func leaseRenewEnvelope(t *testing.T, desktopSessionID string) *ipc.Envelope {
	t.Helper()
	payload, err := json.Marshal(ipc.DesktopLeaseRenewRequest{SessionID: desktopSessionID})
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: "renew-" + desktopSessionID, Type: ipc.TypeDesktopLeaseRenew, Payload: payload}
}

// When root stops a Linux desktop helper, every desktop session it owned is
// reported ended, fenced terminal, and can no longer be renewed by it.
func TestLinuxDesktopHelperStopped_EndsOwnedDesktopsAndDeniesRenewals(t *testing.T) {
	s1, _ := createTestSocketPair(t)
	s2, _ := createTestSocketPair(t)
	stopped := sessionbroker.NewSession(ipc.NewConn(s1), 1000, "1000", "alice", "", "ld-helper", []string{"desktop"})
	other := sessionbroker.NewSession(ipc.NewConn(s2), 1001, "1001", "bob", "", "other-helper", []string{"desktop"})
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager(), wsDesktopMgr: desktop.NewWsSessionManager()}
	h.sessionBroker = newTestBrokerWithSessions(t, stopped, other)
	var renewed []string
	h.leaseRenewRequester = func(id string) { renewed = append(renewed, id) }

	const owned, foreign = "desk-owned-1", "desk-foreign-1"
	h.desktopOwners.Store(owned, "ld-helper")
	h.desktopOwners.Store(foreign, "other-helper")

	// Control: while the helper is live, its renewal goes through.
	h.handleUserHelperMessage(stopped, leaseRenewEnvelope(t, owned))
	if len(renewed) != 1 {
		t.Fatalf("control renewal not forwarded: %v", renewed)
	}

	h.linuxDesktopHelperStopped(stopped, "logout")

	if h.desktopOwnerSession(owned) != nil {
		t.Fatal("stopped helper still owns its desktop session")
	}
	if !h.desktopStartFence.isTerminal(owned) {
		t.Fatal("owned desktop session not fenced terminal")
	}
	h.handleUserHelperMessage(stopped, leaseRenewEnvelope(t, owned))
	if len(renewed) != 1 {
		t.Fatalf("renewal forwarded after the helper was stopped: %v", renewed)
	}
	// Another helper's session is untouched.
	if h.desktopOwnerSession(foreign) != other || h.desktopStartFence.isTerminal(foreign) {
		t.Fatal("a session owned by another helper was ended")
	}
	h.linuxDesktopHelperStopped(nil, "x") // tolerated
}

func TestLinuxDesktopHelperEnabled(t *testing.T) {
	on := &config.Config{DesktopWaylandHelper: true}
	off := &config.Config{}
	cases := []struct {
		goos string
		cfg  *config.Config
		want bool
	}{
		{"linux", on, true},
		{"linux", off, false},
		{"linux", nil, false},
		{"darwin", on, false},
		{"windows", on, false},
	}
	for _, tc := range cases {
		if got := linuxDesktopHelperEnabled(tc.goos, tc.cfg); got != tc.want {
			t.Errorf("linuxDesktopHelperEnabled(%s, %+v) = %v, want %v", tc.goos, tc.cfg, got, tc.want)
		}
	}
}

// With the flag off the manager is never constructed.
func TestStartLinuxDesktopHelperManager_FlagOffConstructsNothing(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}, stopChan: make(chan struct{})}
	h.sessionBroker = newTestBrokerWithSessions(t)
	h.startLinuxDesktopHelperManager()
	if h.linuxDesktopHelpers.Load() != nil {
		t.Fatal("manager constructed with the flag off")
	}
}

// Root's clamp on a Linux desktop helper's capture claim (#12117 W3): the
// flag on Linux AND a build that carries the Wayland backend.
func TestLinuxWaylandCaptureAuthorizer(t *testing.T) {
	on := &config.Config{DesktopWaylandHelper: true}
	off := &config.Config{DesktopWaylandHelper: false}
	cases := []struct {
		name     string
		goos     string
		cfg      *config.Config
		compiled bool
		want     bool
	}{
		{"linux, flag on, backend compiled", "linux", on, true, true},
		{"linux, flag on, no backend", "linux", on, false, false},
		{"linux, flag off, backend compiled", "linux", off, true, false},
		{"linux, no config", "linux", nil, true, false},
		{"darwin, flag on, backend compiled", "darwin", on, true, false},
		{"windows, flag on, backend compiled", "windows", on, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := linuxWaylandCaptureAuthorizer(tc.goos, tc.cfg, tc.compiled)(); got != tc.want {
				t.Fatalf("authorized = %v, want %v", got, tc.want)
			}
		})
	}
	// This build: even with the flag on, a helper's capture claim is clamped.
	if linuxWaylandCaptureAuthorizer("linux", on, desktop.WaylandBackendCompiled)() {
		t.Fatal("W3 must clamp every Linux desktop helper's CanCapture to false")
	}
}
