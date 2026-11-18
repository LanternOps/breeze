package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// fakeLinuxDesktopHelpers stands in for the Linux desktop helper manager.
type fakeLinuxDesktopHelpers struct {
	mu        sync.Mutex
	ensured   []string
	ensureErr error
	bound     map[string]*sessionbroker.Session
	started   map[string]int
	ended     map[string]int
}

func newFakeLinuxDesktopHelpers() *fakeLinuxDesktopHelpers {
	return &fakeLinuxDesktopHelpers{
		bound:   make(map[string]*sessionbroker.Session),
		started: make(map[string]int),
		ended:   make(map[string]int),
	}
}

func (f *fakeLinuxDesktopHelpers) Ensure(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured = append(f.ensured, id)
	return f.ensureErr
}

func (f *fakeLinuxDesktopHelpers) BoundSession(id string) *sessionbroker.Session {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bound[id]
}

func (f *fakeLinuxDesktopHelpers) NoteDesktopStarted(id string) {
	f.mu.Lock()
	f.started[id]++
	f.mu.Unlock()
}

func (f *fakeLinuxDesktopHelpers) NoteDesktopEnded(id string) {
	f.mu.Lock()
	f.ended[id]++
	f.mu.Unlock()
}

func (f *fakeLinuxDesktopHelpers) ensureCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ensured...)
}

func (f *fakeLinuxDesktopHelpers) counts(id string) (started, ended int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.started[id], f.ended[id]
}

func withLinuxDesktopRouteHostOS(t *testing.T, goos string) {
	t.Helper()
	prev := linuxDesktopRouteHostOS
	linuxDesktopRouteHostOS = goos
	t.Cleanup(func() { linuxDesktopRouteHostOS = prev })
}

func seatSession(id, typ string) *sessionbroker.DetectedSession {
	return &sessionbroker.DetectedSession{
		UID: 1000, Session: id, Seat: "seat0", State: "active", Class: "user", LogindType: typ,
	}
}

// linuxRouteHarness is a Linux heartbeat whose start paths are observed:
// the direct in-root start, the helper lookup and the seat lookup each count
// their calls, and none of them touches a display or a real helper.
type linuxRouteHarness struct {
	h           *Heartbeat
	helpers     *fakeLinuxDesktopHelpers
	directCalls atomic.Int32
	seatCalls   atomic.Int32
	helperCalls atomic.Int32
	helperTgts  []string
	mu          sync.Mutex
}

func newLinuxRouteHarness(t *testing.T, flag bool, active *sessionbroker.DetectedSession, withManager bool) *linuxRouteHarness {
	t.Helper()
	withLinuxDesktopRouteHostOS(t, "linux")
	r := &linuxRouteHarness{helpers: newFakeLinuxDesktopHelpers()}
	h := &Heartbeat{
		config:        &config.Config{DesktopWaylandHelper: flag},
		isService:     true,
		isHeadless:    true,
		sessionBroker: newTestBrokerWithSessions(t),
		desktopMgr:    desktop.NewSessionManager(),
	}
	if withManager {
		h.linuxDesktopHelperOverride = r.helpers
	}
	h.linuxActiveSeatSession = func(context.Context) (*sessionbroker.DetectedSession, error) {
		r.seatCalls.Add(1)
		return active, nil
	}
	h.desktopDirectStart = func(string, string, []desktop.ICEServerConfig, int, desktop.SessionPolicy) (string, error) {
		r.directCalls.Add(1)
		return "direct-answer", nil
	}
	h.helperFinder = func(target string) *sessionbroker.Session {
		r.helperCalls.Add(1)
		r.mu.Lock()
		r.helperTgts = append(r.helperTgts, target)
		r.mu.Unlock()
		return nil
	}
	r.h = h
	return r
}

func TestLinuxDesktopRoute_Table(t *testing.T) {
	cases := []struct {
		name       string
		flag       bool
		active     *sessionbroker.DetectedSession
		hasManager bool
		want       linuxDesktopRouteKind
	}{
		{"flag off, wayland", false, seatSession("3", "wayland"), true, routeDirectX11},
		{"flag off, x11", false, seatSession("3", "x11"), true, routeDirectX11},
		{"flag off, nothing", false, nil, false, routeDirectX11},
		{"flag on, x11", true, seatSession("3", "x11"), true, routeDirectX11},
		{"flag on, x11, no manager", true, seatSession("3", "x11"), false, routeDirectX11},
		{"flag on, wayland, manager", true, seatSession("3", "wayland"), true, routeHelper},
		{"flag on, wayland, no manager", true, seatSession("3", "wayland"), false, routeDirectX11},
		{"flag on, no active session", true, nil, true, routeDirectX11},
		{"flag on, tty", true, seatSession("3", "tty"), true, routeDirectX11},
		{"flag on, mir", true, seatSession("3", "mir"), true, routeDirectX11},
		{"flag on, empty type", true, seatSession("3", ""), true, routeDirectX11},
		{"flag on, wayland, incomplete answer", true, func() *sessionbroker.DetectedSession {
			s := seatSession("3", "wayland")
			s.PropertiesUnknown = true
			return s
		}(), true, routeDirectX11},
		{"flag on, wayland, no session id", true, seatSession("", "wayland"), true, routeDirectX11},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := linuxDesktopRoute(tc.flag, tc.active, tc.hasManager); got != tc.want {
				t.Fatalf("linuxDesktopRoute = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStartDesktop_LinuxX11UnchangedWithFlagOn(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("3", "x11"), true)

	result := handleStartDesktop(r.h, startDesktopCmd("sess-linux-x11", nil))

	if result.Status != "completed" {
		t.Fatalf("x11 direct start must complete, got %q: %s", result.Status, result.Error)
	}
	if got := r.directCalls.Load(); got != 1 {
		t.Fatalf("direct start calls = %d, want 1", got)
	}
	if got := r.helperCalls.Load(); got != 0 {
		t.Fatalf("x11 must never take the helper path, helper lookups = %d", got)
	}
	if got := r.helpers.ensureCalls(); len(got) != 0 {
		t.Fatalf("x11 must never spawn a helper, Ensure calls = %v", got)
	}
}

func TestStartDesktop_LinuxWaylandFlagOffUnchanged(t *testing.T) {
	// The flag is off: no manager exists, and logind is not even asked.
	r := newLinuxRouteHarness(t, false, seatSession("3", "wayland"), false)

	result := handleStartDesktop(r.h, startDesktopCmd("sess-linux-wl-off", nil))

	if result.Status != "completed" {
		t.Fatalf("flag-off start must take the direct path, got %q: %s", result.Status, result.Error)
	}
	if got := r.directCalls.Load(); got != 1 {
		t.Fatalf("direct start calls = %d, want 1", got)
	}
	if got := r.helperCalls.Load(); got != 0 {
		t.Fatalf("flag off must never take the helper path, helper lookups = %d", got)
	}
	if got := r.seatCalls.Load(); got != 0 {
		t.Fatalf("flag off must not consult logind, seat lookups = %d", got)
	}
}

func TestStartDesktop_LinuxWaylandFlagOnWithoutManagerUnchanged(t *testing.T) {
	// The manager failed to start: today's direct path, logind not asked.
	r := newLinuxRouteHarness(t, true, seatSession("3", "wayland"), false)

	result := handleStartDesktop(r.h, startDesktopCmd("sess-linux-wl-noman", nil))

	if r.directCalls.Load() != 1 || r.helperCalls.Load() != 0 || r.seatCalls.Load() != 0 {
		t.Fatalf("no manager must keep the direct path: direct=%d helper=%d seat=%d (status %q %s)",
			r.directCalls.Load(), r.helperCalls.Load(), r.seatCalls.Load(), result.Status, result.Error)
	}
}

func TestStartDesktop_LinuxSeatLookupFailureKeepsDirectPath(t *testing.T) {
	r := newLinuxRouteHarness(t, true, nil, true)
	r.h.linuxActiveSeatSession = func(context.Context) (*sessionbroker.DetectedSession, error) {
		r.seatCalls.Add(1)
		return nil, errors.New("logind unavailable")
	}

	handleStartDesktop(r.h, startDesktopCmd("sess-linux-seat-err", nil))

	if r.directCalls.Load() != 1 || r.helperCalls.Load() != 0 {
		t.Fatalf("an unreadable seat must keep the direct path: direct=%d helper=%d",
			r.directCalls.Load(), r.helperCalls.Load())
	}
}

func TestStartDesktop_LinuxWaylandFlagOnRoutesToHelper(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("7", "wayland"), true)

	result := handleStartDesktop(r.h, startDesktopCmd("sess-linux-wl-on", nil))

	if got := r.directCalls.Load(); got != 0 {
		t.Fatalf("a Wayland start with the flag on must never start capture in root, direct calls = %d", got)
	}
	if got := r.helperCalls.Load(); got != 1 {
		t.Fatalf("helper lookups = %d, want 1", got)
	}
	r.mu.Lock()
	tgts := append([]string(nil), r.helperTgts...)
	r.mu.Unlock()
	if len(tgts) != 1 || tgts[0] != "7" {
		t.Fatalf("helper looked up for %v, want the active logind session [7]", tgts)
	}
	if result.Status != "failed" {
		t.Fatalf("no helper can capture yet, so the start must fail, got %q", result.Status)
	}
	// The failed start released its live-desktop mark on the helper.
	if started, ended := r.helpers.counts("7"); started != ended {
		t.Fatalf("live-desktop accounting unbalanced after a failed start: started=%d ended=%d", started, ended)
	}
}

func TestSpawnHelperForDesktop_LinuxWaylandCallsEnsure(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("5", "wayland"), true)

	if err := r.h.spawnHelperForDesktop("5"); err != nil {
		t.Fatalf("spawnHelperForDesktop: %v", err)
	}
	if got := r.helpers.ensureCalls(); len(got) != 1 || got[0] != "5" {
		t.Fatalf("Ensure calls = %v, want [5]", got)
	}

	// Ensure's refusal is returned as is, so the caller can stop waiting.
	r.helpers.ensureErr = sessionbroker.ErrLinuxDesktopSessionNotEligible
	if err := r.h.spawnHelperForDesktop("5"); !errors.Is(err, sessionbroker.ErrLinuxDesktopSessionNotEligible) {
		t.Fatalf("spawnHelperForDesktop error = %v, want ErrLinuxDesktopSessionNotEligible", err)
	}
}

func TestSpawnHelperForDesktop_LinuxOtherRoutesUnsupported(t *testing.T) {
	cases := []struct {
		name    string
		flag    bool
		manager bool
		target  string
	}{
		{"flag off", false, true, "5"},
		{"no manager", true, false, "5"},
		{"untargeted", true, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newLinuxRouteHarness(t, tc.flag, seatSession("5", "wayland"), tc.manager)
			if err := r.h.spawnHelperForDesktop(tc.target); !errors.Is(err, ErrLinuxDesktopHelperUnsupported) {
				t.Fatalf("spawnHelperForDesktop error = %v, want ErrLinuxDesktopHelperUnsupported", err)
			}
			if got := r.helpers.ensureCalls(); len(got) != 0 {
				t.Fatalf("Ensure must not be called, got %v", got)
			}
		})
	}
}

// linuxDesktopTestSession is an admitted-looking Linux desktop helper
// session with the given capabilities (nil = none reported yet).
func linuxDesktopTestSession(t *testing.T, logindID string, caps *ipc.Capabilities, scopes []string) *sessionbroker.Session {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	t.Cleanup(func() { _ = clientConn.Close() })
	s := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "wayland-0", "linux-helper-"+logindID, scopes)
	s.LinuxDesktop = &sessionbroker.LinuxDesktopBinding{UID: 1000, Username: "alice", LogindSessionID: logindID, Generation: 1}
	if caps != nil {
		s.SetCapabilities(caps)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestFindActiveHelper_LinuxRequiresBoundCapableDesktopHelper(t *testing.T) {
	cases := []struct {
		name   string
		caps   *ipc.Capabilities
		scopes []string
		want   bool
	}{
		{"capable", &ipc.Capabilities{CanCapture: true}, []string{"desktop"}, true},
		{"cannot capture", &ipc.Capabilities{CanCapture: false}, []string{"desktop"}, false},
		{"no capabilities yet", nil, []string{"desktop"}, false},
		{"no desktop scope", &ipc.Capabilities{CanCapture: true}, []string{"notify"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
			s := linuxDesktopTestSession(t, "4", tc.caps, tc.scopes)
			r.helpers.bound["4"] = s
			got := r.h.findActiveHelper("4")
			if (got == s) != tc.want {
				t.Fatalf("findActiveHelper returned %v, want bound=%v", got, tc.want)
			}
			// Another session's helper is never handed out.
			if other := r.h.findActiveHelper("9"); other != nil {
				t.Fatalf("findActiveHelper for another logind session returned %v", other)
			}
		})
	}
}

func TestFindOrSpawnLinuxHelper_IncapableHelperIsTerminal(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
	r.helpers.bound["4"] = linuxDesktopTestSession(t, "4", &ipc.Capabilities{CanCapture: false}, []string{"desktop"})

	s, err := r.h.findOrSpawnLinuxHelper("4")
	if s != nil {
		t.Fatalf("an incapable helper must not be returned, got %v", s)
	}
	if err == nil || !strings.Contains(err.Error(), "cannot capture") {
		t.Fatalf("error = %v, want a cannot-capture explanation", err)
	}
	if got := r.helpers.ensureCalls(); len(got) != 1 {
		t.Fatalf("Ensure calls = %v, want exactly one", got)
	}
}

func TestFindOrSpawnLinuxHelper_EnsureRefusalIsTerminal(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
	r.helpers.ensureErr = sessionbroker.ErrLinuxDesktopMultipleWaylandSessions

	s, err := r.h.findOrSpawnLinuxHelper("4")
	if s != nil || !errors.Is(err, sessionbroker.ErrLinuxDesktopMultipleWaylandSessions) {
		t.Fatalf("findOrSpawnLinuxHelper = %v, %v; want nil, ErrLinuxDesktopMultipleWaylandSessions", s, err)
	}
}

func TestStartDesktopViaLinuxHelper_FailedStartReleasesLiveMark(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
	s := linuxDesktopTestSession(t, "4", &ipc.Capabilities{CanCapture: true}, []string{"desktop"})
	_ = s.Close() // the helper is gone: the start command cannot be sent
	r.h.helperFinder = func(string) *sessionbroker.Session { return s }

	result := r.h.startDesktopViaLinuxHelper("desk-fail", "4", ipc.DesktopStartRequest{SessionID: "desk-fail"})

	if result.Status == "completed" {
		t.Fatal("a start on a closed helper session must fail")
	}
	if started, ended := r.helpers.counts("4"); started != 1 || ended != 1 {
		t.Fatalf("a failed start must release its live mark: started=%d ended=%d, want 1/1", started, ended)
	}
	if _, ok := r.h.linuxHostedDesktops.Load("desk-fail"); ok {
		t.Fatal("a failed start left its hosted-desktop record behind")
	}
}

// A routed Wayland desktop session ends for good when root stops its helper
// for any reason — a crash, a logout, a fast user switch — and releases its
// live mark on the helper exactly once.
func TestLinuxRoutedDesktop_HelperStopEndsSessionAndReleasesLiveMark(t *testing.T) {
	for _, reason := range []string{"helper_exited", "logout", "session_inactive", "ambiguous_session"} {
		t.Run(reason, func(t *testing.T) {
			r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
			serverConn, clientConn := createTestSocketPair(t)
			client := ipc.NewConn(clientConn)
			s := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "wayland-0", "linux-helper-4", []string{"desktop"})
			s.LinuxDesktop = &sessionbroker.LinuxDesktopBinding{UID: 1000, Username: "alice", LogindSessionID: "4", Generation: 1}
			s.SetCapabilities(&ipc.Capabilities{CanCapture: true})
			t.Cleanup(func() { _ = s.Close(); _ = client.Close() })
			go s.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
			go func() {
				client.SetReadDeadline(time.Now().Add(5 * time.Second))
				env, err := client.Recv()
				if err != nil {
					return
				}
				payload, _ := json.Marshal(ipc.DesktopStartResponse{SessionID: "desk-live", Answer: "answer"})
				_ = client.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Payload: payload})
			}()
			r.h.sessionBroker = newTestBrokerWithSessions(t, s)
			r.h.helperFinder = func(string) *sessionbroker.Session { return s }

			result := r.h.startDesktopViaLinuxHelper("desk-live", "4", ipc.DesktopStartRequest{SessionID: "desk-live"})
			if result.Status != "completed" {
				t.Fatalf("routed start failed: %s", result.Error)
			}
			if r.h.desktopOwnerSession("desk-live") != s {
				t.Fatal("the helper does not own the started desktop session")
			}
			if started, ended := r.helpers.counts("4"); started != 1 || ended != 0 {
				t.Fatalf("live session not marked live: started=%d ended=%d", started, ended)
			}

			// What the manager's hook runs when root stops or loses the helper.
			r.h.linuxDesktopHelperStopped(s, reason)

			if r.h.desktopOwnerSession("desk-live") != nil {
				t.Fatal("a stopped helper still owns the desktop session")
			}
			if !r.h.desktopStartFence.isTerminal("desk-live") {
				t.Fatal("the desktop session was not fenced terminal")
			}
			if started, ended := r.helpers.counts("4"); started != 1 || ended != 1 {
				t.Fatalf("live mark not released once: started=%d ended=%d", started, ended)
			}
			// A late teardown report for the same session changes nothing.
			r.h.forgetDesktopOwner("desk-live")
			if _, ended := r.helpers.counts("4"); ended != 1 {
				t.Fatalf("live mark released %d times, want 1", ended)
			}
		})
	}
}

// A fast user switch between two starts: each start goes to the helper of
// the session then active on the seat, never to the previous user's.
func TestStartDesktop_LinuxRouteFollowsActiveSeat(t *testing.T) {
	r := newLinuxRouteHarness(t, true, nil, true)
	var mu sync.Mutex
	active := seatSession("3", "wayland")
	r.h.linuxActiveSeatSession = func(context.Context) (*sessionbroker.DetectedSession, error) {
		mu.Lock()
		defer mu.Unlock()
		return active, nil
	}

	handleStartDesktop(r.h, startDesktopCmd("sess-before-switch", nil))
	mu.Lock()
	active = seatSession("8", "wayland")
	mu.Unlock()
	handleStartDesktop(r.h, startDesktopCmd("sess-after-switch", nil))
	mu.Lock()
	active = seatSession("9", "x11")
	mu.Unlock()
	handleStartDesktop(r.h, startDesktopCmd("sess-x11-user", nil))

	r.mu.Lock()
	tgts := append([]string(nil), r.helperTgts...)
	r.mu.Unlock()
	if len(tgts) != 2 || tgts[0] != "3" || tgts[1] != "8" {
		t.Fatalf("helper targets = %v, want [3 8]", tgts)
	}
	if got := r.directCalls.Load(); got != 1 {
		t.Fatalf("the X11 user's start must take the direct path once, direct calls = %d", got)
	}
}

func TestLinuxHostedDesktop_EndedOnceWhenOwnerForgotten(t *testing.T) {
	r := newLinuxRouteHarness(t, true, seatSession("4", "wayland"), true)
	r.h.noteLinuxHostedDesktop("desk-1", "4")
	r.h.rememberDesktopOwner("desk-1", "linux-helper-4")

	r.h.forgetDesktopOwner("desk-1")
	r.h.forgetDesktopOwner("desk-1")
	r.h.endLinuxHostedDesktop("desk-1")

	if started, ended := r.helpers.counts("4"); started != 1 || ended != 1 {
		t.Fatalf("live-desktop accounting: started=%d ended=%d, want 1/1", started, ended)
	}
}
