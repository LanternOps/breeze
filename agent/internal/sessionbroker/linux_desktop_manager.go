package sessionbroker

// On-demand lifecycle of the Linux per-session desktop helper (#12117).
//
// One entry per logind session. Root owns every decision: when to spawn, the
// retry budget, idle expiry and teardown. Nothing the helper sends changes
// any of them, and teardown never depends on the helper cooperating: root
// revokes the ticket, closes the broker session, tells the control plane the
// desktop sessions ended, stops the unit, and finally kills a surviving pid
// whose identity it re-checked. Untagged, with the clock, spawner, logind
// and broker injected, so every rule is tested on every host.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// linuxDesktopMaxAttempts is the spawn budget one demand gets.
	linuxDesktopMaxAttempts = 3
	// linuxDesktopEnsureDeadline bounds one demand's respawn chain, from its
	// first attempt. A helper that stays connected longer than this ends the
	// chain; its later crash starts a new one.
	linuxDesktopEnsureDeadline = 30 * time.Second
	// linuxDesktopExhaustedCooldown is how long a session whose budget ran
	// out is refused before a new demand gets a fresh budget.
	linuxDesktopExhaustedCooldown = 60 * time.Second
	// linuxDesktopHelperIdleExit is root's idle expiry for a helper with no
	// live desktop session, enforced whether or not the helper exits itself.
	linuxDesktopHelperIdleExit = 5 * time.Minute
	// linuxDesktopSpawnConnectTimeout is how long a spawned helper has to
	// connect; it cannot after its ticket expires anyway.
	linuxDesktopSpawnConnectTimeout = linuxDesktopTicketTTL
	// linuxDesktopReconcileEvery paces the logind reconcile.
	linuxDesktopReconcileEvery = 5 * time.Second
	// linuxDesktopTickEvery paces respawns and timeouts.
	linuxDesktopTickEvery = time.Second
	// linuxDesktopKillGrace is how long a stopped helper's pid may outlive
	// the unit stop before root kills it.
	linuxDesktopKillGrace = 5 * time.Second
	// linuxDesktopShutdownBudget bounds stopping every helper at shutdown.
	linuxDesktopShutdownBudget = 5 * time.Second
	// linuxDesktopLogindFailureLimit is how many reconciles in a row may fail
	// to read a bound session from logind before root stops its helper.
	linuxDesktopLogindFailureLimit = 2
	// maxLinuxDesktopSweepUsers bounds the orphan sweep.
	maxLinuxDesktopSweepUsers = 32
)

// linuxDesktopBackoff is the wait before the 1st, 2nd and 3rd respawn of a
// chain.
var linuxDesktopBackoff = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}

var (
	// ErrLinuxDesktopSessionNotEligible: logind does not report the session
	// as an active, local, Wayland user session root may spawn into.
	ErrLinuxDesktopSessionNotEligible = errors.New("logind session is not eligible for a desktop helper")
	// ErrLinuxDesktopMultipleWaylandSessions: the uid has another graphical
	// session sharing its user bus, so the session is ambiguous.
	ErrLinuxDesktopMultipleWaylandSessions = errors.New("user has more than one graphical session")
	// ErrLinuxDesktopSpawnBackoff: a spawn failed recently; try later.
	ErrLinuxDesktopSpawnBackoff = errors.New("desktop helper spawn is backing off")
	// ErrLinuxDesktopAgentUpdatePending: the agent executable on disk is not
	// the running build, so a spawned helper would be refused admission.
	ErrLinuxDesktopAgentUpdatePending = errors.New("agent update pending; desktop helper not spawned")
	// ErrLinuxDesktopManagerClosed: the manager has shut down.
	ErrLinuxDesktopManagerClosed = errors.New("linux desktop helper manager stopped")
)

// LinuxDesktopHooks is what the manager tells the rest of the agent.
type LinuxDesktopHooks struct {
	// OnHelperStopped runs once for every bound helper session that ended,
	// whether root stopped it or it went away. The heartbeat implementation
	// reports each desktop session the helper owned as ended to the API,
	// marks it terminal at the start fence, and refuses further lease
	// renewals for it.
	OnHelperStopped func(s *Session, reason string)
}

// linuxDesktopBrokerOps is the part of the broker the manager drives.
type linuxDesktopBrokerOps interface {
	IssueLinuxDesktopTicket(LinuxDesktopBinding) (string, error)
	RevokeLinuxDesktopTickets(logindSessionID string)
	EnsureLinuxDesktopListener(uid uint32) (string, error)
	CloseLinuxDesktopListener(uid uint32)
	runningBuildHash() string
	helperPaths() []string
	AddSessionLifecycleObserver(authenticated, closed func(*Session)) (remove func())
}

type linuxDesktopState int

const (
	linuxDesktopIdle linuxDesktopState = iota
	linuxDesktopSpawning
	linuxDesktopConnected
)

type linuxDesktopEntry struct {
	binding LinuxDesktopBinding // Generation is the current spawn's
	unit    string
	state   linuxDesktopState
	session *Session

	// The retry budget of the current demand chain.
	attempts    int
	failures    int
	chainStart  time.Time
	nextAttempt time.Time
	respawnDue  bool
	lastErr     error

	spawnStartedAt time.Time
	connectedAt    time.Time
	idleSince      time.Time
	liveDesktops   int
	pendingStart   bool
	logindFailures int

	// Identity of the connected helper's process, for the final kill.
	peerPID      int
	peerStart    uint64
	peerUID      uint32
	peerRecorded bool
}

type linuxDesktopExhaustion struct {
	until time.Time
	err   error
}

// LinuxDesktopHelperManager owns the Linux desktop helpers.
type LinuxDesktopHelperManager struct {
	mu        sync.Mutex
	bySession map[string]*linuxDesktopEntry
	exhausted map[string]linuxDesktopExhaustion
	nextGen   uint64
	closed    bool

	ops     linuxDesktopBrokerOps
	spawner linuxDesktopSpawner
	lookup  logindLookupFunc
	list    func(context.Context) ([]DetectedSession, error)
	hooks   LinuxDesktopHooks
	now     func() time.Time

	// Host seams, set to the real implementations by the constructor.
	agentExe       func() (string, error)
	hashFile       func(string) (string, error)
	waylandDisplay func(ctx context.Context, logindSessionID string, uid uint32) (string, error)
	afterFunc      func(time.Duration, func())
	peerIdentity   func(pid int) (startTime uint64, uid uint32, alive bool)
	killPeer       func(pid int, uid uint32, startTime uint64)

	lastReconcile  time.Time
	removeObserver func()
}

// NewLinuxDesktopHelperManager builds a manager over b. It is constructed
// only on Linux with the desktop_wayland_helper flag on.
func NewLinuxDesktopHelperManager(b *Broker, sp linuxDesktopSpawner, lookup logindLookupFunc, list func(context.Context) ([]DetectedSession, error), hooks LinuxDesktopHooks, now func() time.Time) *LinuxDesktopHelperManager {
	m := newLinuxDesktopHelperManager(b, sp, lookup, list, hooks, now)
	m.attach()
	return m
}

func newLinuxDesktopHelperManager(ops linuxDesktopBrokerOps, sp linuxDesktopSpawner, lookup logindLookupFunc, list func(context.Context) ([]DetectedSession, error), hooks LinuxDesktopHooks, now func() time.Time) *LinuxDesktopHelperManager {
	if now == nil {
		now = time.Now
	}
	return &LinuxDesktopHelperManager{
		bySession: make(map[string]*linuxDesktopEntry),
		exhausted: make(map[string]linuxDesktopExhaustion),
		ops:       ops,
		spawner:   sp,
		lookup:    lookup,
		list:      list,
		hooks:     hooks,
		now:       now,
		agentExe:  resolvedAgentExecutable,
		hashFile:  hashFileSHA256,
		waylandDisplay: func(context.Context, string, uint32) (string, error) {
			return "", errors.New("no wayland display lookup")
		},
		afterFunc:    func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		peerIdentity: linuxDesktopPeerIdentity,
		killPeer:     killLinuxDesktopPeer,
	}
}

// attach registers the broker lifecycle callbacks.
func (m *LinuxDesktopHelperManager) attach() {
	m.removeObserver = m.ops.AddSessionLifecycleObserver(m.onSessionAuthenticated, m.OnSessionClosed)
}

func resolvedAgentExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// Ensure makes sure a helper is running, or starting, in logind session id.
// Idempotent: a session whose helper is connected or still starting returns
// nil without spawning again.
func (m *LinuxDesktopHelperManager) Ensure(ctx context.Context, logindSessionID string) error {
	if m.isClosed() {
		return ErrLinuxDesktopManagerClosed
	}
	binding, err := m.eligibleBinding(ctx, logindSessionID)
	if err != nil {
		return err
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrLinuxDesktopManagerClosed
	}
	now := m.now()
	if ex, ok := m.exhausted[logindSessionID]; ok {
		if now.Before(ex.until) {
			m.mu.Unlock()
			return ex.err
		}
		delete(m.exhausted, logindSessionID)
	}
	e := m.bySession[logindSessionID]
	if e != nil && (e.binding.UID != binding.UID || e.binding.Username != binding.Username) {
		m.mu.Unlock()
		m.Stop(ctx, logindSessionID, "uid_changed")
		m.mu.Lock()
		e = m.bySession[logindSessionID]
	}
	if e == nil {
		e = &linuxDesktopEntry{binding: binding}
		m.bySession[logindSessionID] = e
	}
	switch e.state {
	case linuxDesktopConnected, linuxDesktopSpawning:
		m.mu.Unlock()
		return nil
	}
	e.pendingStart = true
	if e.attempts > 0 && now.Before(e.nextAttempt) {
		last := e.lastErr
		m.mu.Unlock()
		if last != nil {
			return fmt.Errorf("%w: %v", ErrLinuxDesktopSpawnBackoff, last)
		}
		return ErrLinuxDesktopSpawnBackoff
	}
	return m.spawnLocked(ctx, logindSessionID, e)
}

// eligibleBinding asks logind about the session and checks everything a
// spawn needs before any ticket is minted.
func (m *LinuxDesktopHelperManager) eligibleBinding(ctx context.Context, id string) (LinuxDesktopBinding, error) {
	if !validLogindSessionID(id) {
		return LinuxDesktopBinding{}, fmt.Errorf("%w: malformed session id", ErrLinuxDesktopSessionNotEligible)
	}
	lctx, cancel := context.WithTimeout(ctx, linuxDesktopLogindTimeout)
	st, err := m.lookup(lctx, id)
	cancel()
	if err != nil {
		return LinuxDesktopBinding{}, fmt.Errorf("%w: logind: %v", ErrLinuxDesktopSessionNotEligible, err)
	}
	if !st.PropertiesUnknown && st.Exists && st.OtherGraphicalSessions > 0 {
		return LinuxDesktopBinding{}, ErrLinuxDesktopMultipleWaylandSessions
	}
	if reason, ok := linuxDesktopSessionLive(st, LinuxDesktopBinding{UID: st.UID}); !ok {
		return LinuxDesktopBinding{}, fmt.Errorf("%w: %s", ErrLinuxDesktopSessionNotEligible, reason)
	}
	username := ""
	if m.list != nil {
		sessions, err := m.list(ctx)
		if err != nil {
			return LinuxDesktopBinding{}, fmt.Errorf("%w: session list: %v", ErrLinuxDesktopSessionNotEligible, err)
		}
		for _, s := range sessions {
			if s.Session == id && s.UID == st.UID {
				username = s.Username
				break
			}
		}
	}
	if !validLinuxUsername(username) {
		return LinuxDesktopBinding{}, fmt.Errorf("%w: no usable user name for uid %d", ErrLinuxDesktopSessionNotEligible, st.UID)
	}
	return LinuxDesktopBinding{UID: st.UID, Username: username, LogindSessionID: id}, nil
}

// spawnLocked starts a helper for e. Called with m.mu held; returns with it
// released.
func (m *LinuxDesktopHelperManager) spawnLocked(ctx context.Context, id string, e *linuxDesktopEntry) error {
	now := m.now()
	if e.attempts > 0 && now.Sub(e.chainStart) > linuxDesktopEnsureDeadline {
		e.attempts, e.failures = 0, 0
	}
	if e.attempts == 0 {
		e.chainStart = now
	}
	if e.attempts >= linuxDesktopMaxAttempts {
		m.mu.Unlock()
		return m.exhaust(ctx, id, e)
	}
	e.attempts++
	attempt := e.attempts
	m.nextGen++
	gen := m.nextGen
	e.binding.Generation = gen
	e.state = linuxDesktopSpawning
	e.spawnStartedAt = now
	e.respawnDue = false
	e.unit = ""
	binding := e.binding
	m.mu.Unlock()

	unit, err := m.startHelper(ctx, binding)

	m.mu.Lock()
	cur := m.bySession[id]
	if cur != e || e.binding.Generation != gen || m.closed {
		// Stopped or replaced while starting: nothing may survive it.
		m.mu.Unlock()
		m.ops.RevokeLinuxDesktopTickets(id)
		if err == nil && unit != "" {
			m.stopUnit(binding.Username, unit)
		}
		if err != nil {
			return err
		}
		return ErrLinuxDesktopSessionNotEligible
	}
	if err != nil {
		e.state = linuxDesktopIdle
		m.mu.Unlock()
		m.ops.RevokeLinuxDesktopTickets(id)
		log.Warn("Linux desktop helper spawn failed", "logindSession", id, "uid", binding.UID,
			"generation", gen, "attempt", attempt, "error", err.Error())
		m.mu.Lock()
		if m.bySession[id] == e {
			m.recordFailureLocked(e, err)
		}
		m.mu.Unlock()
		return err
	}
	e.unit = unit
	m.mu.Unlock()
	log.Info("Linux desktop helper spawned", "logindSession", id, "uid", binding.UID, "generation", gen, "unit", unit)
	return nil
}

// startHelper runs the pre-spawn checks, opens the endpoint, mints the
// ticket and starts the unit.
func (m *LinuxDesktopHelperManager) startHelper(ctx context.Context, binding LinuxDesktopBinding) (string, error) {
	exe, err := m.agentExe()
	if err != nil {
		return "", fmt.Errorf("agent executable: %w", err)
	}
	if !binaryPathMatchesAllowed(exe, m.ops.helperPaths()) {
		return "", fmt.Errorf("agent executable %s is not an allowed helper path", exe)
	}
	// The broker admits only the running build; a helper started from a
	// different file on disk would burn its ticket for nothing.
	running := m.ops.runningBuildHash()
	onDisk, err := m.hashFile(exe)
	if err != nil {
		return "", fmt.Errorf("hash agent executable: %w", err)
	}
	if running == "" || onDisk != running {
		return "", ErrLinuxDesktopAgentUpdatePending
	}
	display, err := m.waylandDisplay(ctx, binding.LogindSessionID, binding.UID)
	if err != nil {
		return "", fmt.Errorf("%w: wayland display: %v", ErrLinuxDesktopSessionNotEligible, err)
	}
	socket, err := m.ops.EnsureLinuxDesktopListener(binding.UID)
	if err != nil {
		return "", fmt.Errorf("desktop endpoint: %w", err)
	}
	ticket, err := m.ops.IssueLinuxDesktopTicket(binding)
	if err != nil {
		return "", fmt.Errorf("spawn ticket: %w", err)
	}
	return m.spawner.Start(ctx, LinuxDesktopSpawnSpec{
		Binding:        binding,
		Ticket:         ticket,
		AgentExe:       exe,
		SocketPath:     socket,
		RuntimeDir:     fmt.Sprintf("/run/user/%d", binding.UID),
		WaylandDisplay: display,
	})
}

// recordFailureLocked charges a failure to e's chain and schedules the next
// attempt when the demand still stands and the budget allows.
func (m *LinuxDesktopHelperManager) recordFailureLocked(e *linuxDesktopEntry, err error) {
	now := m.now()
	e.lastErr = err
	e.failures++
	idx := min(e.failures-1, len(linuxDesktopBackoff)-1)
	e.nextAttempt = now.Add(linuxDesktopBackoff[idx])
	e.respawnDue = true
}

// exhaust ends a chain whose budget ran out: the session is refused for the
// cool-down and its entry is stopped.
func (m *LinuxDesktopHelperManager) exhaust(ctx context.Context, id string, e *linuxDesktopEntry) error {
	m.mu.Lock()
	err := e.lastErr
	if err == nil {
		err = errors.New("desktop helper did not stay connected")
	}
	err = fmt.Errorf("desktop helper spawn budget exhausted: %w", err)
	m.exhausted[id] = linuxDesktopExhaustion{until: m.now().Add(linuxDesktopExhaustedCooldown), err: err}
	m.mu.Unlock()
	log.Warn("Linux desktop helper spawn budget exhausted", "logindSession", id, "uid", e.binding.UID, "error", err.Error())
	m.Stop(ctx, id, "spawn_failed")
	return err
}

// onSessionAuthenticated binds a newly admitted helper to its entry. Anything
// that is not the current spawn of a known entry is closed.
func (m *LinuxDesktopHelperManager) onSessionAuthenticated(s *Session) {
	if s == nil || s.LinuxDesktop == nil {
		return
	}
	b := *s.LinuxDesktop
	pid := s.PID
	var start uint64
	var uid uint32
	recorded := false
	if pid > 0 {
		start, uid, recorded = m.peerIdentity(pid)
	}

	m.mu.Lock()
	e := m.bySession[b.LogindSessionID]
	if m.closed || e == nil || e.binding.Generation != b.Generation || e.binding.UID != b.UID || e.state == linuxDesktopConnected {
		m.mu.Unlock()
		log.Warn("closing a Linux desktop helper that is not the current spawn",
			"logindSession", b.LogindSessionID, "generation", b.Generation, "uid", b.UID)
		_ = s.Close()
		return
	}
	now := m.now()
	e.state = linuxDesktopConnected
	e.session = s
	e.connectedAt = now
	e.pendingStart = false
	e.respawnDue = false
	if e.liveDesktops == 0 {
		e.idleSince = now
	}
	e.peerPID, e.peerStart, e.peerUID, e.peerRecorded = pid, start, uid, recorded && uid == b.UID
	m.mu.Unlock()
	log.Info("Linux desktop helper connected", "logindSession", b.LogindSessionID, "generation", b.Generation, "uid", b.UID)
}

// OnSessionClosed handles the end of a bound helper's broker session that
// root did not initiate: a crash or an exit.
func (m *LinuxDesktopHelperManager) OnSessionClosed(s *Session) {
	if s == nil || s.LinuxDesktop == nil {
		return
	}
	id := s.LinuxDesktop.LogindSessionID
	m.mu.Lock()
	e := m.bySession[id]
	if e == nil || e.session != s {
		m.mu.Unlock()
		return
	}
	now := m.now()
	e.session = nil
	e.state = linuxDesktopIdle
	chainActive := e.attempts > 0 && now.Sub(e.chainStart) <= linuxDesktopEnsureDeadline
	demand := chainActive || e.liveDesktops > 0 || e.pendingStart
	e.liveDesktops = 0
	unit, user := e.unit, e.binding.Username
	e.unit = ""
	if demand {
		if !chainActive {
			e.attempts, e.failures = 0, 0
		}
		m.recordFailureLocked(e, errors.New("desktop helper exited"))
	}
	exhausted := demand && e.attempts >= linuxDesktopMaxAttempts
	m.mu.Unlock()

	log.Warn("Linux desktop helper session ended", "logindSession", id, "uid", s.UID, "respawn", demand && !exhausted)
	m.ops.RevokeLinuxDesktopTickets(id)
	if m.hooks.OnHelperStopped != nil {
		m.hooks.OnHelperStopped(s, "helper_exited")
	}
	if unit != "" {
		m.stopUnit(user, unit)
	}
	switch {
	case exhausted:
		_ = m.exhaust(context.Background(), id, e)
	case !demand:
		m.Stop(context.Background(), id, "helper_exited")
	}
}

// Stop tears down the helper for a logind session without relying on it:
// revoke the ticket and close the broker session, report its desktop
// sessions ended, stop the unit, and kill a surviving pid whose identity
// still matches. The entry is forgotten; the uid's endpoint closes with its
// last entry.
func (m *LinuxDesktopHelperManager) Stop(ctx context.Context, logindSessionID, reason string) {
	m.mu.Lock()
	e := m.bySession[logindSessionID]
	if e == nil {
		m.mu.Unlock()
		m.ops.RevokeLinuxDesktopTickets(logindSessionID)
		return
	}
	delete(m.bySession, logindSessionID)
	s := e.session
	unit, user, uid := e.unit, e.binding.Username, e.binding.UID
	pid, start, peerUID, recorded := e.peerPID, e.peerStart, e.peerUID, e.peerRecorded
	lastForUID := true
	for _, other := range m.bySession {
		if other.binding.UID == uid {
			lastForUID = false
			break
		}
	}
	m.mu.Unlock()

	log.Info("stopping Linux desktop helper", "logindSession", logindSessionID, "uid", uid, "reason", reason)
	// 1. No scope survives this point, and no new ticket exists.
	m.ops.RevokeLinuxDesktopTickets(logindSessionID)
	if s != nil {
		_ = s.Close()
		// 2. The control plane ends the viewer side and stops renewing.
		if m.hooks.OnHelperStopped != nil {
			m.hooks.OnHelperStopped(s, reason)
		}
	}
	// 3. Collect the unit.
	if unit != "" {
		m.stopUnitCtx(ctx, user, unit)
	}
	// 4. A pid that outlives the stop is killed, after re-checking that it is
	// still the same process.
	if s != nil && recorded && pid > 0 {
		m.afterFunc(linuxDesktopKillGrace, func() {
			curStart, curUID, alive := m.peerIdentity(pid)
			if shouldKillLinuxDesktopPeer(recorded, start, peerUID, alive, curStart, curUID) {
				log.Warn("Linux desktop helper outlived its stop; killing it", "pid", pid, "uid", peerUID)
				m.killPeer(pid, peerUID, start)
			}
		})
	}
	if lastForUID {
		m.ops.CloseLinuxDesktopListener(uid)
	}
}

func (m *LinuxDesktopHelperManager) stopUnit(user, unit string) {
	m.stopUnitCtx(context.Background(), user, unit)
}

func (m *LinuxDesktopHelperManager) stopUnitCtx(ctx context.Context, user, unit string) {
	if err := m.spawner.Stop(ctx, user, unit); err != nil {
		log.Warn("could not stop Linux desktop helper unit", "unit", unit, "error", err.Error())
	}
}

// shouldKillLinuxDesktopPeer allows the final SIGKILL only for the very
// process root admitted: recorded at admission, still alive, same start
// time and uid, and never uid 0.
func shouldKillLinuxDesktopPeer(recorded bool, recStart uint64, recUID uint32, alive bool, curStart uint64, curUID uint32) bool {
	return recorded && alive && recUID != 0 && recStart != 0 && recStart == curStart && recUID == curUID
}

// BoundSession returns the connected helper for a logind session, or nil.
func (m *LinuxDesktopHelperManager) BoundSession(logindSessionID string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.bySession[logindSessionID]; e != nil && e.state == linuxDesktopConnected {
		return e.session
	}
	return nil
}

// NoteDesktopStarted / NoteDesktopEnded track live desktop sessions on a
// session's helper; a helper with one is never idle-expired, and its crash
// is respawned.
func (m *LinuxDesktopHelperManager) NoteDesktopStarted(logindSessionID string) {
	m.mu.Lock()
	if e := m.bySession[logindSessionID]; e != nil {
		e.liveDesktops++
	}
	m.mu.Unlock()
}

func (m *LinuxDesktopHelperManager) NoteDesktopEnded(logindSessionID string) {
	m.mu.Lock()
	if e := m.bySession[logindSessionID]; e != nil && e.liveDesktops > 0 {
		e.liveDesktops--
		if e.liveDesktops == 0 {
			e.idleSince = m.now()
		}
	}
	m.mu.Unlock()
}

func (m *LinuxDesktopHelperManager) isClosed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closed
}

// Run sweeps orphaned units, then drives respawns, timeouts and the logind
// reconcile until ctx ends, and finally stops every helper.
func (m *LinuxDesktopHelperManager) Run(ctx context.Context) {
	m.sweepOrphans(ctx)
	ticker := time.NewTicker(linuxDesktopTickEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.shutdown()
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

// tick runs due respawns and spawn timeouts, and the reconcile when due.
func (m *LinuxDesktopHelperManager) tick(ctx context.Context) {
	now := m.now()
	var due, timedOut []string
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	for id, e := range m.bySession {
		switch {
		case e.state == linuxDesktopSpawning && now.Sub(e.spawnStartedAt) > linuxDesktopSpawnConnectTimeout:
			timedOut = append(timedOut, id)
		case e.state == linuxDesktopIdle && e.respawnDue && !now.Before(e.nextAttempt):
			due = append(due, id)
		}
	}
	reconcileDue := now.Sub(m.lastReconcile) >= linuxDesktopReconcileEvery
	m.mu.Unlock()

	for _, id := range timedOut {
		m.spawnTimedOut(id)
	}
	for _, id := range due {
		m.respawn(ctx, id)
	}
	if reconcileDue {
		m.reconcile(ctx)
	}
}

// spawnTimedOut handles a spawned helper that never connected.
func (m *LinuxDesktopHelperManager) spawnTimedOut(id string) {
	m.mu.Lock()
	e := m.bySession[id]
	if e == nil || e.state != linuxDesktopSpawning {
		m.mu.Unlock()
		return
	}
	unit, user := e.unit, e.binding.Username
	e.unit = ""
	e.state = linuxDesktopIdle
	m.recordFailureLocked(e, errors.New("desktop helper did not connect"))
	exhausted := e.attempts >= linuxDesktopMaxAttempts
	m.mu.Unlock()
	log.Warn("Linux desktop helper did not connect in time", "logindSession", id, "unit", unit)
	m.ops.RevokeLinuxDesktopTickets(id)
	if unit != "" {
		m.stopUnit(user, unit)
	}
	if exhausted {
		_ = m.exhaust(context.Background(), id, e)
	}
}

// respawn re-runs eligibility and spawns again for a due entry. A session
// logind no longer reports live is stopped instead.
func (m *LinuxDesktopHelperManager) respawn(ctx context.Context, id string) {
	binding, err := m.eligibleBinding(ctx, id)
	m.mu.Lock()
	e := m.bySession[id]
	if e == nil || e.state != linuxDesktopIdle || !e.respawnDue {
		m.mu.Unlock()
		return
	}
	if err != nil || binding.UID != e.binding.UID {
		m.mu.Unlock()
		reason := "session_ineligible"
		if errors.Is(err, ErrLinuxDesktopMultipleWaylandSessions) {
			reason = "ambiguous_session"
		}
		m.Stop(ctx, id, reason)
		return
	}
	if e.attempts >= linuxDesktopMaxAttempts {
		m.mu.Unlock()
		_ = m.exhaust(ctx, id, e)
		return
	}
	_ = m.spawnLocked(ctx, id, e)
}

// reconcile checks every entry against logind and the idle expiry.
func (m *LinuxDesktopHelperManager) reconcile(ctx context.Context) {
	now := m.now()
	m.mu.Lock()
	m.lastReconcile = now
	ids := make([]string, 0, len(m.bySession))
	for id := range m.bySession {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		lctx, cancel := context.WithTimeout(ctx, linuxDesktopLogindTimeout)
		st, err := m.lookup(lctx, id)
		cancel()

		m.mu.Lock()
		e := m.bySession[id]
		if e == nil {
			m.mu.Unlock()
			continue
		}
		reason := ""
		switch {
		case err != nil || st.PropertiesUnknown:
			e.logindFailures++
			if e.logindFailures >= linuxDesktopLogindFailureLimit {
				reason = "logind_unavailable"
			}
		case !st.Exists || st.State == "closing":
			reason = "logout"
		case st.UID != e.binding.UID:
			reason = "uid_changed"
		case st.OtherGraphicalSessions > 0:
			reason = "ambiguous_session"
		case st.State != "active":
			reason = "session_inactive"
		default:
			if _, ok := linuxDesktopSessionLive(st, e.binding); !ok {
				reason = "session_ineligible"
			}
			e.logindFailures = 0
		}
		if reason == "" && e.state == linuxDesktopConnected && e.liveDesktops == 0 &&
			now.Sub(e.idleSince) >= linuxDesktopHelperIdleExit {
			reason = "idle"
		}
		m.mu.Unlock()
		if reason != "" {
			m.Stop(ctx, id, reason)
		}
	}
}

// sweepOrphans stops helper units a previous agent run left behind, in the
// manager of every user with a session now.
func (m *LinuxDesktopHelperManager) sweepOrphans(ctx context.Context) {
	if m.list == nil {
		return
	}
	sessions, err := m.list(ctx)
	if err != nil {
		log.Warn("Linux desktop helper orphan sweep: session list failed", "error", err.Error())
		return
	}
	seen := make(map[string]bool)
	for _, s := range sessions {
		if s.UID == 0 || !validLinuxUsername(s.Username) || seen[s.Username] {
			continue
		}
		if len(seen) >= maxLinuxDesktopSweepUsers {
			break
		}
		seen[s.Username] = true
		units, err := m.spawner.ListUnits(ctx, s.Username)
		if err != nil {
			log.Warn("Linux desktop helper orphan sweep: list failed", "uid", s.UID, "error", err.Error())
			continue
		}
		for _, unit := range units {
			if m.ownsUnit(unit) {
				continue
			}
			log.Info("stopping orphaned Linux desktop helper unit", "uid", s.UID, "unit", unit)
			m.stopUnitCtx(ctx, s.Username, unit)
		}
	}
}

func (m *LinuxDesktopHelperManager) ownsUnit(unit string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.bySession {
		if e.unit == unit {
			return true
		}
	}
	return false
}

// shutdown stops every helper within linuxDesktopShutdownBudget and refuses
// new ones.
func (m *LinuxDesktopHelperManager) shutdown() {
	m.mu.Lock()
	m.closed = true
	ids := make([]string, 0, len(m.bySession))
	for id := range m.bySession {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), linuxDesktopShutdownBudget)
	defer cancel()
	for _, id := range ids {
		m.Stop(ctx, id, "agent_shutdown")
	}
	if m.removeObserver != nil {
		m.removeObserver()
	}
}
