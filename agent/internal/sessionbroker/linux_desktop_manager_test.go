package sessionbroker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// ---- fakes ---------------------------------------------------------------

type ldClock struct {
	mu sync.Mutex
	t  time.Time
}

func newLDClock() *ldClock { return &ldClock{t: time.Unix(1_800_000_000, 0)} }
func (c *ldClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *ldClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// ldOps fakes the broker side: a real ticket store, recorded endpoint calls.
type ldOps struct {
	mu        sync.Mutex
	tickets   *linuxDesktopTickets
	issued    []LinuxDesktopBinding
	revoked   []string
	ensured   []uint32
	closed    []uint32
	buildHash string
	paths     []string
	ensureErr error
	onAuth    func(*Session)
	onClosed  func(*Session)
}

func newLDOps(clock *ldClock) *ldOps {
	return &ldOps{tickets: newLinuxDesktopTickets(clock.now), buildHash: "hash-running", paths: []string{"/opt/breeze/breeze-agent"}}
}

func (o *ldOps) IssueLinuxDesktopTicket(b LinuxDesktopBinding) (string, error) {
	o.mu.Lock()
	o.issued = append(o.issued, b)
	o.mu.Unlock()
	return o.tickets.issue(b)
}
func (o *ldOps) RevokeLinuxDesktopTickets(id string) {
	o.mu.Lock()
	o.revoked = append(o.revoked, id)
	o.mu.Unlock()
	o.tickets.revokeSession(id)
}
func (o *ldOps) EnsureLinuxDesktopListener(uid uint32) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ensured = append(o.ensured, uid)
	if o.ensureErr != nil {
		return "", o.ensureErr
	}
	return fmt.Sprintf("/run/breeze/desktop/%d.sock", uid), nil
}
func (o *ldOps) CloseLinuxDesktopListener(uid uint32) {
	o.mu.Lock()
	o.closed = append(o.closed, uid)
	o.mu.Unlock()
}
func (o *ldOps) runningBuildHash() string { return o.buildHash }
func (o *ldOps) helperPaths() []string    { return o.paths }
func (o *ldOps) AddSessionLifecycleObserver(a, c func(*Session)) func() {
	o.mu.Lock()
	o.onAuth, o.onClosed = a, c
	o.mu.Unlock()
	return func() {}
}
func (o *ldOps) closedUIDs() []uint32 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]uint32(nil), o.closed...)
}
func (o *ldOps) revokedIDs() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.revoked...)
}

type ldSpawner struct {
	mu       sync.Mutex
	starts   []LinuxDesktopSpawnSpec
	stops    []string
	startErr error
	gate     chan struct{} // when set, Start blocks until closed
	units    map[string][]string
	listed   []string
	unitSeq  int
}

func (s *ldSpawner) Start(_ context.Context, spec LinuxDesktopSpawnSpec) (string, error) {
	if s.gate != nil {
		<-s.gate
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.starts = append(s.starts, spec)
	if s.startErr != nil {
		return "", s.startErr
	}
	s.unitSeq++
	return fmt.Sprintf("breeze-desktop-helper-%s-g%d-%08x.service", spec.Binding.LogindSessionID, spec.Binding.Generation, s.unitSeq), nil
}
func (s *ldSpawner) Stop(_ context.Context, user, unit string) error {
	s.mu.Lock()
	s.stops = append(s.stops, user+"/"+unit)
	s.mu.Unlock()
	return nil
}
func (s *ldSpawner) ListUnits(_ context.Context, user string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listed = append(s.listed, user)
	return s.units[user], nil
}
func (s *ldSpawner) startCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.starts)
}
func (s *ldSpawner) lastStart() LinuxDesktopSpawnSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.starts[len(s.starts)-1]
}
func (s *ldSpawner) stopCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.stops)
}

type ldLogind struct {
	mu     sync.Mutex
	states map[string]LogindSessionState
	err    error
}

func (l *ldLogind) lookup(_ context.Context, id string) (LogindSessionState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err != nil {
		return LogindSessionState{}, l.err
	}
	st, ok := l.states[id]
	if !ok {
		return LogindSessionState{Exists: false}, nil
	}
	return st, nil
}
func (l *ldLogind) set(id string, f func(*LogindSessionState)) {
	l.mu.Lock()
	st := l.states[id]
	f(&st)
	l.states[id] = st
	l.mu.Unlock()
}
func (l *ldLogind) remove(id string) {
	l.mu.Lock()
	delete(l.states, id)
	l.mu.Unlock()
}

type ldHooks struct {
	mu      sync.Mutex
	stopped []string // sessionID/reason
}

func (h *ldHooks) hooks() LinuxDesktopHooks {
	return LinuxDesktopHooks{OnHelperStopped: func(s *Session, reason string) {
		h.mu.Lock()
		h.stopped = append(h.stopped, s.SessionID+"/"+reason)
		h.mu.Unlock()
	}}
}
func (h *ldHooks) calls() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.stopped...)
}

type ldRig struct {
	m      *LinuxDesktopHelperManager
	clock  *ldClock
	ops    *ldOps
	sp     *ldSpawner
	logind *ldLogind
	hooks  *ldHooks
	killed atomic.Int32
	users  []DetectedSession
	exe    string
}

const ldSession = "3"

func newLDRig(t *testing.T) *ldRig {
	t.Helper()
	r := &ldRig{clock: newLDClock(), sp: &ldSpawner{}, hooks: &ldHooks{}}
	r.ops = newLDOps(r.clock)
	r.logind = &ldLogind{states: map[string]LogindSessionState{
		ldSession: {UID: 1000, Type: "wayland", State: "active", Class: "user", Exists: true},
	}}
	r.users = []DetectedSession{{UID: 1000, Username: "alice", Session: ldSession, State: "active", LogindType: "wayland", Class: "user"}}
	r.m = newLinuxDesktopHelperManager(r.ops, r.sp, r.logind.lookup,
		func(context.Context) ([]DetectedSession, error) { return r.users, nil },
		r.hooks.hooks(), r.clock.now)
	// A real file: the allowed-path check resolves symlinks.
	exe := filepath.Join(t.TempDir(), "breeze-agent")
	if err := os.WriteFile(exe, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	r.exe = exe
	r.ops.paths = []string{exe}
	r.m.agentExe = func() (string, error) { return exe, nil }
	r.m.hashFile = func(string) (string, error) { return r.ops.runningBuildHash(), nil }
	r.m.waylandDisplay = func(context.Context, string, uint32) (string, error) { return "wayland-0", nil }
	r.m.afterFunc = func(_ time.Duration, f func()) { f() }
	r.m.killPeer = func(pid int, uid uint32, start uint64) { r.killed.Add(1) }
	r.m.peerIdentity = func(pid int) (uint64, uint32, bool) { return 42, 1000, true }
	r.m.attach()
	return r
}

// connect simulates the spawned helper authenticating with the latest
// generation, through the broker's lifecycle observer.
func (r *ldRig) connect(t *testing.T) *Session {
	t.Helper()
	spec := r.sp.lastStart()
	b := spec.Binding
	if _, err := r.ops.tickets.consume(spec.Ticket, b.LogindSessionID, b.UID); err != nil {
		t.Fatalf("helper could not redeem its ticket: %v", err)
	}
	a, _ := net.Pipe()
	t.Cleanup(func() { _ = a.Close() })
	s := NewSession(ipc.NewConn(a), b.UID, "1000", b.Username, "", fmt.Sprintf("helper-g%d", b.Generation), []string{"desktop"})
	s.LinuxDesktop = &b
	s.PID = 4000 + int(b.Generation)
	r.ops.onAuth(s)
	return s
}

// crash simulates the helper's broker session ending.
func (r *ldRig) crash(s *Session) {
	_ = s.closeTransport()
	r.ops.onClosed(s)
}

func (r *ldRig) tick() { r.m.tick(context.Background()) }

// ---- tests ---------------------------------------------------------------

func TestLinuxDesktopManager_EnsureSpawnsOnceConcurrently(t *testing.T) {
	r := newLDRig(t)
	r.sp.gate = make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- r.m.Ensure(context.Background(), ldSession)
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(r.sp.gate)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("Ensure: %v", err)
		}
	}
	if n := r.sp.startCount(); n != 1 {
		t.Fatalf("Start called %d times, want 1", n)
	}
	spec := r.sp.lastStart()
	if spec.Binding.UID != 1000 || spec.Binding.Username != "alice" || spec.SocketPath != "/run/breeze/desktop/1000.sock" ||
		spec.RuntimeDir != "/run/user/1000" || spec.AgentExe != r.exe || spec.Ticket == "" {
		t.Fatalf("spawn spec %+v", spec)
	}
	if err := r.m.Ensure(context.Background(), ldSession); err != nil || r.sp.startCount() != 1 {
		t.Fatalf("Ensure while spawning: %v, starts %d", err, r.sp.startCount())
	}
	s := r.connect(t)
	if got := r.m.BoundSession(ldSession); got != s {
		t.Fatalf("BoundSession = %v, want the connected helper", got)
	}
	if err := r.m.Ensure(context.Background(), ldSession); err != nil || r.sp.startCount() != 1 {
		t.Fatalf("Ensure while connected: %v, starts %d", err, r.sp.startCount())
	}
}

func TestLinuxDesktopManager_EnsureRejectsInactiveX11RemoteGreeter(t *testing.T) {
	cases := map[string]func(*LogindSessionState){
		"inactive":  func(s *LogindSessionState) { s.State = "online" },
		"x11":       func(s *LogindSessionState) { s.Type = "x11" },
		"remote":    func(s *LogindSessionState) { s.Remote = true },
		"greeter":   func(s *LogindSessionState) { s.Class = "greeter" },
		"root":      func(s *LogindSessionState) { s.UID = 0 },
		"missing":   func(s *LogindSessionState) { s.Exists = false },
		"unknown":   func(s *LogindSessionState) { s.PropertiesUnknown = true },
		"closing":   func(s *LogindSessionState) { s.State = "closing" },
		"tty":       func(s *LogindSessionState) { s.Type = "tty" },
		"bad class": func(s *LogindSessionState) { s.Class = "background" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := newLDRig(t)
			r.logind.set(ldSession, mutate)
			err := r.m.Ensure(context.Background(), ldSession)
			if !errors.Is(err, ErrLinuxDesktopSessionNotEligible) {
				t.Fatalf("err = %v, want ErrLinuxDesktopSessionNotEligible", err)
			}
			if r.sp.startCount() != 0 || len(r.ops.issued) != 0 {
				t.Fatal("spawned or issued a ticket for an ineligible session")
			}
		})
	}
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), "3;x"); !errors.Is(err, ErrLinuxDesktopSessionNotEligible) {
		t.Fatalf("malformed id: %v", err)
	}
	r.logind.err = errors.New("dbus down")
	if err := r.m.Ensure(context.Background(), ldSession); !errors.Is(err, ErrLinuxDesktopSessionNotEligible) {
		t.Fatalf("logind error: %v", err)
	}
	r.logind.err = nil
	r.users = nil // username unknown
	if err := r.m.Ensure(context.Background(), ldSession); !errors.Is(err, ErrLinuxDesktopSessionNotEligible) {
		t.Fatalf("unknown user: %v", err)
	}
}

func TestLinuxDesktopManager_MultipleWaylandSessionsRefused(t *testing.T) {
	r := newLDRig(t)
	r.logind.set(ldSession, func(s *LogindSessionState) { s.OtherGraphicalSessions = 1 })
	if err := r.m.Ensure(context.Background(), ldSession); !errors.Is(err, ErrLinuxDesktopMultipleWaylandSessions) {
		t.Fatalf("err = %v, want ErrLinuxDesktopMultipleWaylandSessions", err)
	}
	if r.sp.startCount() != 0 {
		t.Fatal("spawned into an ambiguous uid")
	}
}

func TestLinuxDesktopManager_UpdatePendingRefusesSpawn(t *testing.T) {
	r := newLDRig(t)
	r.m.hashFile = func(string) (string, error) { return "hash-on-disk-new", nil }
	if err := r.m.Ensure(context.Background(), ldSession); !errors.Is(err, ErrLinuxDesktopAgentUpdatePending) {
		t.Fatalf("err = %v, want ErrLinuxDesktopAgentUpdatePending", err)
	}
	r.m.hashFile = func(string) (string, error) { return "", errors.New("unreadable") }
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("spawned with an unreadable agent executable")
	}
	r.m.hashFile = func(string) (string, error) { return r.ops.runningBuildHash(), nil }
	r.ops.paths = []string{"/elsewhere/breeze-agent"}
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("spawned an executable outside the allowed helper paths")
	}
	if r.sp.startCount() != 0 {
		t.Fatal("Start called")
	}
}

func TestLinuxDesktopManager_SpawnFailureBacksOff(t *testing.T) {
	r := newLDRig(t)
	r.sp.startErr = errors.New("systemd-run failed")
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("Ensure returned nil for a failed Start")
	}
	// Before the backoff: refused, nothing spawned.
	if err := r.m.Ensure(context.Background(), ldSession); !errors.Is(err, ErrLinuxDesktopSpawnBackoff) {
		t.Fatalf("Ensure during backoff: %v", err)
	}
	if r.sp.startCount() != 1 {
		t.Fatalf("starts = %d", r.sp.startCount())
	}
	// Root retries on its own within the budget: +1 s, then +2 s.
	r.clock.advance(time.Second)
	r.tick()
	r.clock.advance(2 * time.Second)
	r.tick()
	if r.sp.startCount() != 3 {
		t.Fatalf("starts = %d after retries, want 3", r.sp.startCount())
	}
	// Budget spent: no further spawns, Ensure returns the last error.
	r.clock.advance(10 * time.Second)
	r.tick()
	err := r.m.Ensure(context.Background(), ldSession)
	if err == nil || r.sp.startCount() != 3 {
		t.Fatalf("after budget: err %v, starts %d", err, r.sp.startCount())
	}
	// A failed Start never leaves a usable ticket behind.
	for _, b := range r.ops.issued {
		if _, ok := r.ops.tickets.bySession[b.LogindSessionID]; ok {
			t.Fatal("ticket for a failed spawn still live")
		}
	}
	// After the cool-down a new demand gets a fresh budget.
	r.clock.advance(61 * time.Second)
	r.sp.startErr = nil
	if err := r.m.Ensure(context.Background(), ldSession); err != nil || r.sp.startCount() != 4 {
		t.Fatalf("after cool-down: %v, starts %d", err, r.sp.startCount())
	}
}

func TestLinuxDesktopManager_CrashRespawnsWithBackoff(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.m.NoteDesktopStarted(ldSession)
	r.clock.advance(time.Minute) // a long-lived helper: its crash starts a fresh budget
	r.crash(s)
	if r.sp.startCount() != 1 {
		t.Fatal("respawned with no backoff")
	}
	var spawnTimes []time.Duration
	start := r.clock.now()
	for i := 0; i < 40; i++ { // 10 s in 250 ms steps
		r.clock.advance(250 * time.Millisecond)
		before := r.sp.startCount()
		r.tick()
		if r.sp.startCount() > before {
			spawnTimes = append(spawnTimes, r.clock.now().Sub(start))
			// The respawned helper connects and crashes at once.
			r.crash(r.connect(t))
		}
	}
	want := []time.Duration{time.Second, 3 * time.Second, 7 * time.Second}
	if len(spawnTimes) != len(want) {
		t.Fatalf("respawns at %v, want at %v", spawnTimes, want)
	}
	for i := range want {
		if spawnTimes[i] != want[i] {
			t.Fatalf("respawns at %v, want at %v (+1 s, +2 s, +4 s)", spawnTimes, want)
		}
	}
	if got := r.hooks.calls(); len(got) == 0 {
		t.Fatal("a crashed helper's desktops were not reported ended")
	}
}

func TestLinuxDesktopManager_RetryBudgetNotResetByHelperTraffic(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	// Each spawn connects (it may chatter as much as it likes) and dies within
	// the stable window: connecting never refunds the budget.
	for i := 0; i < 10; i++ {
		before := r.sp.startCount()
		s := r.connect(t)
		r.m.NoteDesktopStarted(ldSession)
		r.clock.advance(100 * time.Millisecond)
		r.crash(s)
		for j := 0; j < 20 && r.sp.startCount() == before; j++ {
			r.clock.advance(500 * time.Millisecond)
			r.tick()
		}
		if r.sp.startCount() == before {
			break
		}
	}
	if n := r.sp.startCount(); n != linuxDesktopMaxAttempts {
		t.Fatalf("starts = %d, want the budget of %d", n, linuxDesktopMaxAttempts)
	}
}

func TestLinuxDesktopManager_IdleExitDoesNotRespawn(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.clock.advance(time.Minute)
	r.crash(s) // the helper exited on its own with no desktop session
	for i := 0; i < 20; i++ {
		r.clock.advance(time.Second)
		r.tick()
	}
	if r.sp.startCount() != 1 {
		t.Fatalf("respawned an idle helper: starts %d", r.sp.startCount())
	}
	if r.sp.stopCount() != 1 {
		t.Fatalf("idle helper's unit not collected: stops %d", r.sp.stopCount())
	}
	if r.m.BoundSession(ldSession) != nil {
		t.Fatal("entry still bound")
	}
	if got := r.ops.closedUIDs(); len(got) != 1 || got[0] != 1000 {
		t.Fatalf("endpoint closes %v, want [1000] once the last entry for the uid went", got)
	}
}

func TestLinuxDesktopManager_RootIdleExpiry(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.clock.advance(linuxDesktopHelperIdleExit - time.Second)
	r.m.reconcile(context.Background())
	if s.IsClosed() {
		t.Fatal("stopped before the idle expiry")
	}
	// A live desktop keeps it.
	r.m.NoteDesktopStarted(ldSession)
	r.clock.advance(time.Hour)
	r.m.reconcile(context.Background())
	if s.IsClosed() {
		t.Fatal("stopped a helper with a live desktop")
	}
	r.m.NoteDesktopEnded(ldSession)
	r.clock.advance(linuxDesktopHelperIdleExit)
	r.m.reconcile(context.Background())
	if !s.IsClosed() {
		t.Fatal("a helper that never exits was not stopped at the idle expiry")
	}
	if r.sp.stopCount() != 1 {
		t.Fatalf("stops %d", r.sp.stopCount())
	}
}

func TestLinuxDesktopManager_SessionGoneStopsHelper(t *testing.T) {
	for name, mutate := range map[string]func(*ldLogind){
		"logout":  func(l *ldLogind) { l.remove(ldSession) },
		"closing": func(l *ldLogind) { l.set(ldSession, func(s *LogindSessionState) { s.State = "closing" }) },
		"uid":     func(l *ldLogind) { l.set(ldSession, func(s *LogindSessionState) { s.UID = 1001 }) },
	} {
		t.Run(name, func(t *testing.T) {
			r := newLDRig(t)
			if err := r.m.Ensure(context.Background(), ldSession); err != nil {
				t.Fatal(err)
			}
			s := r.connect(t)
			r.m.NoteDesktopStarted(ldSession)
			mutate(r.logind)
			r.clock.advance(5 * time.Second)
			r.m.reconcile(context.Background())
			if !s.IsClosed() {
				t.Fatal("helper session survived the logind session")
			}
			if r.sp.stopCount() != 1 {
				t.Fatal("unit not stopped")
			}
			// Never respawned for a session logind no longer reports live.
			for i := 0; i < 20; i++ {
				r.clock.advance(time.Second)
				r.tick()
			}
			if r.sp.startCount() != 1 {
				t.Fatalf("respawned after %s: starts %d", name, r.sp.startCount())
			}
			if err := r.m.Ensure(context.Background(), ldSession); err == nil {
				t.Fatal("Ensure accepted a gone session")
			}
		})
	}
}

func TestLinuxDesktopManager_InactiveSessionEndsLiveDesktop(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.m.NoteDesktopStarted(ldSession)
	r.logind.set(ldSession, func(st *LogindSessionState) { st.State = "online" }) // fast user switch
	r.clock.advance(5 * time.Second)
	r.m.reconcile(context.Background())
	if !s.IsClosed() {
		t.Fatal("helper kept running for an inactive session")
	}
	calls := r.hooks.calls()
	if len(calls) != 1 || calls[0] != s.SessionID+"/session_inactive" {
		t.Fatalf("hook calls %v, want one session_inactive", calls)
	}
}

func TestLinuxDesktopManager_NewSecondSessionStopsHelper(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.logind.set(ldSession, func(st *LogindSessionState) { st.OtherGraphicalSessions = 1 })
	r.clock.advance(5 * time.Second)
	r.m.reconcile(context.Background())
	if !s.IsClosed() {
		t.Fatal("helper kept running for an ambiguous uid")
	}
	if calls := r.hooks.calls(); len(calls) != 1 || calls[0] != s.SessionID+"/ambiguous_session" {
		t.Fatalf("hook calls %v", calls)
	}
}

func TestLinuxDesktopManager_LogindUnavailableStopsAfterRepeatedFailures(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.logind.err = errors.New("dbus timeout")
	r.clock.advance(5 * time.Second)
	r.m.reconcile(context.Background())
	if s.IsClosed() {
		t.Fatal("stopped on one transient logind failure")
	}
	r.clock.advance(5 * time.Second)
	r.m.reconcile(context.Background())
	if !s.IsClosed() {
		t.Fatal("kept a helper while logind could not confirm the session")
	}
}

func TestLinuxDesktopManager_RespawnRevokesOldTicket(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	first := r.sp.lastStart()
	// The first helper never connects; root gives up on it at the ticket TTL
	// and spawns again (the demand is still there).
	r.clock.advance(linuxDesktopTicketTTL + time.Second)
	r.tick()
	for i := 0; i < 10 && r.sp.startCount() < 2; i++ {
		r.clock.advance(time.Second)
		r.tick()
	}
	if r.sp.startCount() != 2 {
		t.Fatalf("starts = %d, want a respawn after the unconnected spawn timed out", r.sp.startCount())
	}
	second := r.sp.lastStart()
	if second.Binding.Generation <= first.Binding.Generation {
		t.Fatalf("generation did not advance: %d then %d", first.Binding.Generation, second.Binding.Generation)
	}
	if _, err := r.ops.tickets.consume(first.Ticket, ldSession, 1000); err == nil {
		t.Fatal("the first spawn's ticket is still redeemable")
	}
	if r.sp.stopCount() < 1 {
		t.Fatal("the unconnected unit was not stopped")
	}
	// A helper presenting the stale generation is refused and closed.
	a, _ := net.Pipe()
	t.Cleanup(func() { _ = a.Close() })
	stale := NewSession(ipc.NewConn(a), 1000, "1000", "alice", "", "stale", []string{"desktop"})
	b := first.Binding
	stale.LinuxDesktop = &b
	r.ops.onAuth(stale)
	if !stale.IsClosed() {
		t.Fatal("a stale-generation helper was kept")
	}
	if r.m.BoundSession(ldSession) == stale {
		t.Fatal("a stale-generation helper was bound")
	}
}

func TestLinuxDesktopManager_StopDoesNotNeedHelperCooperation(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t) // the fake helper ignores everything it is sent
	r.m.Stop(context.Background(), ldSession, "operator")
	if !s.IsClosed() {
		t.Fatal("broker session not closed")
	}
	if got := r.ops.revokedIDs(); len(got) == 0 || got[0] != ldSession {
		t.Fatalf("revocations %v", got)
	}
	if r.sp.stopCount() != 1 {
		t.Fatal("unit not stopped")
	}
	if r.killed.Load() != 1 {
		t.Fatal("surviving peer pid not killed after the grace period")
	}
	if r.m.BoundSession(ldSession) != nil {
		t.Fatal("entry still bound after Stop")
	}
	// A pid whose identity changed (exited and reused) is never signalled.
	r2 := newLDRig(t)
	if err := r2.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	r2.connect(t)
	r2.m.peerIdentity = func(int) (uint64, uint32, bool) { return 99, 1000, true }
	r2.m.Stop(context.Background(), ldSession, "operator")
	if r2.killed.Load() != 0 {
		t.Fatal("signalled a pid whose start time changed")
	}
}

func TestLinuxDesktopManager_StopNotifiesAPIAndDeniesRenewals(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.m.NoteDesktopStarted(ldSession)
	r.m.Stop(context.Background(), ldSession, "operator")
	if calls := r.hooks.calls(); len(calls) != 1 || calls[0] != s.SessionID+"/operator" {
		t.Fatalf("hook calls %v, want OnHelperStopped(operator)", calls)
	}
	// The closed session drives nothing further: its close callback is a no-op.
	r.ops.onClosed(s)
	if len(r.hooks.calls()) != 1 || r.sp.startCount() != 1 {
		t.Fatal("a stopped helper's close was treated as a crash")
	}
}

func TestLinuxDesktopManager_ShutdownStopsAll(t *testing.T) {
	r := newLDRig(t)
	r.logind.states["4"] = LogindSessionState{UID: 1001, Type: "wayland", State: "active", Class: "user", Exists: true}
	r.users = append(r.users, DetectedSession{UID: 1001, Username: "bob", Session: "4"})
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	a := r.connect(t)
	if err := r.m.Ensure(context.Background(), "4"); err != nil {
		t.Fatal(err)
	}
	bSess := r.connect(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.m.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if !a.IsClosed() || !bSess.IsClosed() {
		t.Fatal("helpers survived shutdown")
	}
	if r.sp.stopCount() != 2 {
		t.Fatalf("stops %d, want 2", r.sp.stopCount())
	}
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("Ensure after shutdown spawned")
	}
}

func TestLinuxDesktopManager_OrphanSweepOnStart(t *testing.T) {
	r := newLDRig(t)
	r.users = append(r.users, DetectedSession{UID: 0, Username: "root", Session: "9"},
		DetectedSession{UID: 1002, Username: "a b", Session: "10"},
		DetectedSession{UID: 1000, Username: "alice", Session: "11"})
	r.sp.units = map[string][]string{
		"alice": {"breeze-desktop-helper-3-g1-00000001.service", "breeze-desktop-helper-7-g2-00000002.service"},
		"root":  {"breeze-desktop-helper-1-g1-00000003.service"},
	}
	r.m.sweepOrphans(context.Background())
	r.sp.mu.Lock()
	defer r.sp.mu.Unlock()
	if len(r.sp.listed) != 1 || r.sp.listed[0] != "alice" {
		t.Fatalf("listed users %v, want only alice (once)", r.sp.listed)
	}
	if len(r.sp.stops) != 2 {
		t.Fatalf("stops %v, want both of alice's leftover units", r.sp.stops)
	}
}

func TestShouldKillLinuxDesktopPeer(t *testing.T) {
	cases := []struct {
		name                  string
		recStart, curStart    uint64
		recUID, curUID        uint32
		alive, recorded, want bool
	}{
		{"same process", 42, 42, 1000, 1000, true, true, true},
		{"exited", 42, 0, 1000, 0, false, true, false},
		{"pid reused", 42, 43, 1000, 1000, true, true, false},
		{"uid changed", 42, 42, 1000, 1001, true, true, false},
		{"root", 42, 42, 0, 0, true, true, false},
		{"never recorded", 0, 42, 0, 1000, true, false, false},
	}
	for _, tc := range cases {
		if got := shouldKillLinuxDesktopPeer(tc.recorded, tc.recStart, tc.recUID, tc.alive, tc.curStart, tc.curUID); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
