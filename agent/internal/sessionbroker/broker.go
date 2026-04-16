package sessionbroker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// slowLockThresholdNs is the duration (in nanoseconds, via sync/atomic) above
// which a broker lock acquisition wait OR a broker write-lock hold triggers a
// WARN log. Atomic storage lets tests safely override it from other
// goroutines without tripping -race. Production default is 1s.
var slowLockThresholdNs atomic.Int64

func init() {
	slowLockThresholdNs.Store(int64(time.Second))
}

// slowLockThreshold returns the current threshold as a duration.
func slowLockThreshold() time.Duration {
	return time.Duration(slowLockThresholdNs.Load())
}

// setSlowLockThreshold overrides the threshold and returns the previous
// value. Intended for tests — production code should leave the default alone.
func setSlowLockThreshold(d time.Duration) time.Duration {
	return time.Duration(slowLockThresholdNs.Swap(int64(d)))
}

// timedRWMutex wraps sync.RWMutex and logs a warning when:
//  1. Lock or RLock acquisition waits longer than slowLockThreshold (a sign
//     of contention on the broker).
//  2. A write-lock (Lock) is HELD longer than slowLockThreshold. Long write
//     holds under contention are the direct starvation cause described in
//     issue #387 — e.g. handleConnection holding b.mu.Lock() across a
//     15-second SendCommandAndWait while heartbeat readers pile up.
//
// Read-lock HOLD time is not instrumented. A single `acquiredAt` field cannot
// safely track multiple concurrent RLock holders, and the alternatives
// (goroutine-ID maps, returning tokens from RLock, atomic pointers) either
// race or uglify the API. In this broker, RLock holders never perform
// long-blocking work — the starvation bug is caused by WRITE-lock holders —
// so instrumenting Lock holds alone captures the dangerous class of bug.
//
// The wrapper uses runtime.Callers to automatically identify the calling
// function — no changes are required at individual call sites.
//
// Do not copy by value: the embedded RWMutex and acquiredAt timestamp are
// stateful and must be accessed via pointer.
type timedRWMutex struct {
	_          noCopy
	mu         sync.RWMutex
	acquiredAt time.Time // only valid while write lock is held; read only in Unlock
}

// noCopy may be embedded into structs which must not be copied after the first
// use. See https://golang.org/issues/8005#issuecomment-190753527 — `go vet`
// recognises this pattern.
type noCopy struct{}

func (*noCopy) Lock()   {}
func (*noCopy) Unlock() {}

func callerName(skip int) string {
	var pcs [3]uintptr
	n := runtime.Callers(skip+2, pcs[:])
	if n == 0 {
		return "unknown"
	}
	frames := runtime.CallersFrames(pcs[:n])
	f, _ := frames.Next()
	name := f.Function
	// Strip the package prefix ("sessionbroker/broker.Foo" → "Foo"). Use the
	// last '/' to locate the final path segment, then the first '.' inside
	// that segment to skip the package name. Everything after is the
	// method/function name (possibly with receiver and suffixes).
	if slash := strings.LastIndexByte(name, '/'); slash >= 0 {
		name = name[slash+1:]
	}
	if dot := strings.IndexByte(name, '.'); dot >= 0 {
		name = name[dot+1:]
	}
	// Strip receiver: "(*Broker).handleConnection" → "handleConnection"
	if close := strings.LastIndexByte(name, ')'); close >= 0 && close+1 < len(name) && name[close+1] == '.' {
		name = name[close+2:]
	}
	// Strip method-value ("-fm") and closure ("-func1") suffixes introduced by
	// the compiler.
	if i := strings.IndexByte(name, '-'); i >= 0 {
		name = name[:i]
	}
	// Strip nested closure suffixes ("handleConnection.func1" → "handleConnection").
	// The compiler uses '.' as the closure separator on nested anonymous funcs.
	if i := strings.IndexByte(name, '.'); i >= 0 {
		name = name[:i]
	}
	return name
}

func (t *timedRWMutex) Lock() {
	// Snapshot threshold once so the warn comparisons inside Lock and Unlock
	// see a consistent value even if a test overrides it mid-call.
	threshold := slowLockThreshold()
	start := time.Now()
	t.mu.Lock()
	if waited := time.Since(start); waited > threshold {
		log.Warn("broker write-lock acquisition slow",
			"op", "Lock", "caller", callerName(1), "waited_ms", waited.Milliseconds())
	}
	// Record hold-start timestamp. Safe without additional sync: exactly one
	// writer holds the lock at a time, and the field is only read in Unlock
	// (also under the exclusive lock).
	t.acquiredAt = time.Now()
}

func (t *timedRWMutex) Unlock() {
	// Capture hold duration before releasing — `acquiredAt` is only valid
	// while the write lock is held.
	held := time.Since(t.acquiredAt)
	t.acquiredAt = time.Time{}
	t.mu.Unlock()
	if held > slowLockThreshold() {
		log.Warn("broker write-lock held too long",
			"op", "Lock", "caller", callerName(1), "held_ms", held.Milliseconds())
	}
}

func (t *timedRWMutex) RLock() {
	start := time.Now()
	t.mu.RLock()
	if waited := time.Since(start); waited > slowLockThreshold() {
		log.Warn("broker read-lock acquisition slow",
			"op", "RLock", "caller", callerName(1), "waited_ms", waited.Milliseconds())
	}
}

func (t *timedRWMutex) RUnlock() {
	t.mu.RUnlock()
}

const (
	// HandshakeTimeout is the deadline for completing auth after connecting.
	HandshakeTimeout = 5 * time.Second

	// IdleTimeout disconnects helpers that send no messages for this duration.
	IdleTimeout = 30 * time.Minute

	// MaxConnectionsPerIdentity limits concurrent connections per user identity.
	// Bumped from 3 to 5 so reconnect overlap has headroom — paired with
	// evict-on-admit below, which frees any slot whose holder has gone idle.
	MaxConnectionsPerIdentity = 5

	// EvictIdleThreshold is how idle a session must be before evict-on-admit
	// reclaims its slot for a new connection from the same identity.
	EvictIdleThreshold = 60 * time.Second

	// RateLimitAttempts is max connection attempts per identity per window.
	RateLimitAttempts = 5

	// RateLimitWindow is the sliding window for rate limiting.
	RateLimitWindow = 60 * time.Second

	// IdleCheckInterval is how often to scan for idle sessions.
	IdleCheckInterval = 60 * time.Second
)

// Keepalive tuning. Vars (not consts) so tests can override them to drive
// the goroutine on a short schedule without real sleeps.
var (
	keepalivePingInterval = 30 * time.Second
	keepaliveTimeout      = 45 * time.Second
)

// roleSupportsKeepalive reports whether the broker should drive its generic
// TypePing/TypePong keepalive on a session of the given helper role.
//
// Watchdog is excluded: its IPC client (internal/watchdog/ipcclient.go) only
// handles TypeWatchdogPong and never replies to TypePing, so running keepalive
// against it would evict every watchdog connection at keepaliveTimeout.
// Watchdog has its own end-to-end liveness probe via WatchdogPing/Pong.
func roleSupportsKeepalive(role string) bool {
	return role != ipc.HelperRoleWatchdog
}

// maybeStartKeepalive starts the keepalive goroutine for the session if its
// role supports it. Extracted from handleConnection so the gating is testable
// without driving the full IPC handshake (which needs OS-specific peer creds).
func (b *Broker) maybeStartKeepalive(session *Session, role string) {
	if roleSupportsKeepalive(role) {
		go b.runKeepalive(session)
	}
}

// Role-based scopes: SYSTEM helpers own desktop capture, user-token helpers own script execution.
var (
	systemHelperScopes   = []string{"notify", "tray", "clipboard", "desktop"}
	userHelperScopes     = []string{"notify", "clipboard", "run_as_user"}
	watchdogHelperScopes = []string{"watchdog"}
)

// MessageHandler is called when a user helper sends a message that isn't
// a response to a pending command.
type MessageHandler func(session *Session, env *ipc.Envelope)

// SessionClosedHandler is called after a helper session has been removed.
type SessionClosedHandler func(session *Session)

// sessionSnapshot is an immutable point-in-time view of the broker's session
// maps. It is stored via an atomic.Pointer so lock-free readers (FindCapableSession,
// AllSessions, TCCStatus) can avoid acquiring b.mu.RLock() entirely, preventing
// heartbeat starvation when a write-lock storm (reconnect loop) is in progress.
//
// The snapshot maps are shallow copies of the outer maps: the keys/values are
// copied but the *Session values themselves are not deep-copied. Callers must
// not mutate sessions obtained from a snapshot.
type sessionSnapshot struct {
	sessions    map[string]*Session   // sessionID -> Session
	byIdentity  map[string][]*Session // identity key -> Sessions
	consoleUser string
}

// Broker manages IPC connections from user helper processes.
type Broker struct {
	socketPath  string
	listener    net.Listener
	rateLimiter *ipc.RateLimiter
	startTime   time.Time // broker creation time, used for watchdog uptime

	mu           timedRWMutex
	sessions     map[string]*Session   // sessionID -> Session
	byIdentity   map[string][]*Session // identity key -> Sessions (UID string on Unix, SID on Windows)
	staleHelpers map[string][]int      // winSessionID -> PIDs of disconnected helpers
	consoleUser  string                // macOS: current console user ("loginwindow" at login screen)
	backup       *backupHelper         // backup helper process and session
	closed       bool

	// snap is an atomically updated snapshot of sessions/byIdentity/consoleUser.
	// Updated under b.mu.Lock() on every mutation. Read-only hot paths use
	// snap.Load() instead of acquiring b.mu.RLock(), eliminating reader starvation
	// when the write-lock storm from reconnect loops is in progress.
	snap atomic.Pointer[sessionSnapshot]

	// snapFallbackWarned fires a single WARN the first time snapshotSessions
	// hits the nil-snapshot fallback path. This should only ever happen in
	// tests that construct Broker{} directly; a production occurrence means
	// New() was bypassed somewhere.
	snapFallbackWarned atomic.Bool

	onMessage       MessageHandler
	onSessionClosed SessionClosedHandler
	selfHashes      map[string]struct{} // SHA-256 of allowed helper binaries
}

// New creates a new session broker.
func New(socketPath string, onMessage MessageHandler) *Broker {
	b := &Broker{
		socketPath:   socketPath,
		rateLimiter:  ipc.NewRateLimiter(RateLimitAttempts, RateLimitWindow),
		startTime:    time.Now(),
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
		onMessage:    onMessage,
	}
	b.selfHashes = b.computeAllowedHashes()
	b.publishSnapshotLocked() // initialise with empty maps
	return b
}

// snapshotSessions returns the sessions map and consoleUser via the atomic
// snapshot if available, falling back to a locked *copy* for Broker instances
// that were not created via New() (e.g., test fixtures that construct Broker{} directly).
//
// The returned map must be treated as read-only by callers.
func (b *Broker) snapshotSessions() (map[string]*Session, string) {
	if snap := b.snap.Load(); snap != nil {
		return snap.sessions, snap.consoleUser
	}
	// Fallback path: Broker was constructed directly (likely a test fixture).
	// Warn once if this ever happens — production code should always go
	// through New(), which initialises b.snap. Returning the live map
	// without copying would race with any concurrent writer once the
	// deferred RUnlock below fires.
	if b.snapFallbackWarned.CompareAndSwap(false, true) {
		log.Warn("sessionbroker: snapshotSessions hit nil-snapshot fallback; Broker not initialised via New()")
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	sessions := make(map[string]*Session, len(b.sessions))
	for k, v := range b.sessions {
		sessions[k] = v
	}
	return sessions, b.consoleUser
}

// publishSnapshotLocked builds a new immutable sessionSnapshot from the current
// state and atomically replaces the stored snapshot. Must be called under b.mu.Lock().
func (b *Broker) publishSnapshotLocked() {
	sessionsCopy := make(map[string]*Session, len(b.sessions))
	for k, v := range b.sessions {
		sessionsCopy[k] = v
	}
	byIdentityCopy := make(map[string][]*Session, len(b.byIdentity))
	for k, v := range b.byIdentity {
		cp := make([]*Session, len(v))
		copy(cp, v)
		byIdentityCopy[k] = cp
	}
	b.snap.Store(&sessionSnapshot{
		sessions:    sessionsCopy,
		byIdentity:  byIdentityCopy,
		consoleUser: b.consoleUser,
	})
}

func (b *Broker) SetSessionClosedHandler(handler SessionClosedHandler) {
	b.mu.Lock()
	b.onSessionClosed = handler
	b.mu.Unlock()
}

// SetConsoleUser updates the current macOS console user. When set to
// "loginwindow", desktop session selection prefers login_window helpers.
func (b *Broker) SetConsoleUser(username string) {
	b.mu.Lock()
	prev := b.consoleUser
	b.consoleUser = username
	b.publishSnapshotLocked()
	b.mu.Unlock()
	if prev != username {
		log.Debug("console user changed", "from", prev, "to", username)
	}
}

// Listen starts the IPC listener. Blocks until stopChan is closed.
func (b *Broker) Listen(stopChan <-chan struct{}) error {
	if err := b.setupSocket(); err != nil {
		return fmt.Errorf("sessionbroker: setup socket: %w", err)
	}

	log.Info("session broker listening", "path", b.socketPath)

	// Start idle session reaper
	go b.idleReaper(stopChan)

	// Accept loop
	go func() {
		for {
			conn, err := b.listener.Accept()
			if err != nil {
				b.mu.RLock()
				closed := b.closed
				b.mu.RUnlock()
				if closed {
					return
				}
				log.Warn("accept error", "error", err.Error())
				continue
			}
			go b.handleConnection(conn)
		}
	}()

	<-stopChan
	b.Close()
	return nil
}

// Close shuts down the broker and all sessions.
func (b *Broker) Close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		sessions = append(sessions, s)
	}
	b.mu.Unlock()

	for _, s := range sessions {
		s.Close()
	}

	if b.listener != nil {
		b.listener.Close()
	}

	// Clean up socket file on Unix
	if runtime.GOOS != "windows" {
		os.Remove(b.socketPath)
	}

	log.Info("session broker closed")
}

// SessionForUser returns the first active session for the given username.
func (b *Broker) SessionForUser(username string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var best *Session
	for _, s := range b.sessions {
		if s.Username == username && s.HelperRole == ipc.HelperRoleUser {
			if betterSession(s, best) {
				best = s
			}
		}
	}
	if best != nil {
		return best
	}

	for _, s := range b.sessions {
		if s.Username == username && betterSession(s, best) {
			best = s
		}
	}
	return best
}

// SessionByID returns the currently connected session with the given broker session ID.
func (b *Broker) SessionByID(sessionID string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.sessions[sessionID]
}

// SessionForIdentity returns the first active session for the given identity key.
// The key is a UID string on Unix or a SID on Windows.
func (b *Broker) SessionForIdentity(key string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if sessions, ok := b.byIdentity[key]; ok && len(sessions) > 0 {
		var best *Session
		for _, s := range sessions {
			if betterSession(s, best) {
				best = s
			}
		}
		return best
	}
	return nil
}

// SessionForUID returns the first active session for the given UID.
// Deprecated: Use SessionForIdentity for cross-platform identity.
// On Windows, UID is always 0; this method only works correctly on Unix.
func (b *Broker) SessionForUID(uid uint32) *Session {
	return b.SessionForIdentity(strconv.FormatUint(uint64(uid), 10))
}

// AllSessions returns info about all connected sessions.
// Uses the atomic snapshot to avoid lock contention on the hot path.
func (b *Broker) AllSessions() []SessionInfo {
	sessions, _ := b.snapshotSessions()
	infos := make([]SessionInfo, 0, len(sessions))
	for _, s := range sessions {
		infos = append(infos, s.Info())
	}
	return infos
}

// SessionsWithScope returns the currently connected sessions authorized for the given scope.
func (b *Broker) SessionsWithScope(scope string) []*Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HasScope(scope) {
			sessions = append(sessions, s)
		}
	}
	return sessions
}

// PreferredSessionWithScope returns the most appropriate connected session
// that is authorized for the given scope. User-role helpers are preferred
// over system helpers, then the newest active session wins.
func (b *Broker) PreferredSessionWithScope(scope string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var best *Session
	for _, s := range b.sessions {
		if !s.HasScope(scope) {
			continue
		}
		if best == nil {
			best = s
			continue
		}
		if s.HelperRole == ipc.HelperRoleUser && best.HelperRole != ipc.HelperRoleUser {
			best = s
			continue
		}
		if s.HelperRole != ipc.HelperRoleUser && best.HelperRole == ipc.HelperRoleUser {
			continue
		}
		if betterSession(s, best) {
			best = s
		}
	}
	return best
}

func (b *Broker) PreferredDesktopSession() *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.preferredDesktopSessionLocked()
}

// preferredDesktopSessionFromSnap is the lock-free variant of
// preferredDesktopSessionLocked. It reads from an already-loaded snapshot
// so callers on the heartbeat hot path avoid acquiring b.mu.RLock().
//
// Capabilities are read via Session.GetCapabilities() (which takes s.mu)
// because the snapshot does not protect *Session internal fields — only the
// outer map identity. Direct access to s.Capabilities would race with
// SetCapabilities under -race.
func preferredDesktopSessionFromSnap(snap *sessionSnapshot) *Session {
	atLoginWindow := snap.consoleUser == "loginwindow"

	// Pass 1: if at login window, try login_window helpers first.
	if atLoginWindow {
		var best *Session
		for _, s := range snap.sessions {
			caps := s.GetCapabilities()
			if !s.HasScope("desktop") || caps == nil || !caps.CanCapture {
				continue
			}
			if s.DesktopContext == ipc.DesktopContextLoginWindow {
				if best == nil || betterDesktopSession(s, best) {
					best = s
				}
			}
		}
		if best != nil {
			return best
		}
		// No login_window helper — fall through to user_session helpers.
		// They can still capture the login screen on macOS; input will
		// use IOHIDPostEvent via dynamic switching.
	}

	// Pass 2: best available session (normal selection or login window fallback).
	var best *Session
	for _, s := range snap.sessions {
		caps := s.GetCapabilities()
		if !s.HasScope("desktop") || caps == nil || !caps.CanCapture {
			continue
		}
		if best == nil || betterDesktopSession(s, best) {
			best = s
		}
	}
	return best
}

func (b *Broker) preferredDesktopSessionLocked() *Session {
	atLoginWindow := b.consoleUser == "loginwindow"

	// Pass 1: if at login window, try login_window helpers first.
	if atLoginWindow {
		var best *Session
		for _, s := range b.sessions {
			caps := s.GetCapabilities()
			if !s.HasScope("desktop") || caps == nil || !caps.CanCapture {
				continue
			}
			if s.DesktopContext == ipc.DesktopContextLoginWindow {
				if best == nil || betterDesktopSession(s, best) {
					best = s
				}
			}
		}
		if best != nil {
			return best
		}
		// No login_window helper — fall through to user_session helpers.
		// They can still capture the login screen on macOS; input will
		// use IOHIDPostEvent via dynamic switching.
	}

	// Pass 2: best available session (normal selection or login window fallback).
	var best *Session
	for _, s := range b.sessions {
		caps := s.GetCapabilities()
		if !s.HasScope("desktop") || caps == nil || !caps.CanCapture {
			continue
		}
		if best == nil || betterDesktopSession(s, best) {
			best = s
		}
	}
	return best
}

// TCCStatus returns the TCC permission status from the first connected helper
// session that has reported one, or nil if none have. In practice, only one
// macOS helper per user reports TCC status. Returns a copy to prevent mutation
// of session-internal state.
// Uses the atomic snapshot to avoid lock contention on the heartbeat hot path.
func (b *Broker) TCCStatus() *ipc.TCCStatus {
	// Prefer the full atomic snapshot — it has all three fields populated
	// (sessions, byIdentity, consoleUser), so passing it to snapshot-based
	// helpers like preferredDesktopSessionFromSnap is safe even as those
	// helpers evolve to read additional fields. Fall back to a locked copy
	// only when the broker was constructed directly without New() (tests).
	snap := b.snap.Load()
	if snap == nil {
		sessions, consoleUser := b.snapshotSessions()
		snap = &sessionSnapshot{
			sessions:    sessions,
			byIdentity:  nil, // fallback path: not populated, do not read
			consoleUser: consoleUser,
		}
	}

	if preferred := preferredDesktopSessionFromSnap(snap); preferred != nil {
		if tcc := preferred.GetTCCStatus(); tcc != nil {
			cp := *tcc
			return &cp
		}
	}

	for _, s := range snap.sessions {
		if !s.HasScope("desktop") {
			continue
		}
		if tcc := s.GetTCCStatus(); tcc != nil {
			cp := *tcc
			return &cp
		}
	}

	for _, s := range snap.sessions {
		if tcc := s.GetTCCStatus(); tcc != nil {
			cp := *tcc
			return &cp
		}
	}
	return nil
}

// BroadcastNotification sends a desktop notification to all connected user sessions.
func (b *Broker) BroadcastNotification(title, body, urgency string) {
	b.mu.RLock()
	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		sessions = append(sessions, s)
	}
	b.mu.RUnlock()

	for _, s := range sessions {
		_ = s.SendNotify("", ipc.TypeNotify, &ipc.NotifyRequest{
			Title:   title,
			Body:    body,
			Urgency: urgency,
		})
	}
}

// BroadcastToDesktopSessions sends a fire-and-forget IPC message to all
// connected sessions that have the "desktop" scope.
func (b *Broker) BroadcastToDesktopSessions(msgType string, payload any) {
	b.mu.RLock()
	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HasScope("desktop") {
			sessions = append(sessions, s)
		}
	}
	b.mu.RUnlock()

	for _, s := range sessions {
		if err := s.SendNotify("", msgType, payload); err != nil {
			log.Debug("broadcast to desktop session failed",
				"sessionId", s.SessionID, "msgType", msgType, "error", err.Error())
		}
	}
}

// SessionCount returns the number of active sessions.
// Uses the atomic snapshot to avoid lock contention on the heartbeat hot path.
func (b *Broker) SessionCount() int {
	if snap := b.snap.Load(); snap != nil {
		return len(snap.sessions)
	}
	// Fallback for Broker instances not created via New() (e.g., test fixtures).
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.sessions)
}

// FindCapableSession returns the best connected session whose helper reports
// the given capability (e.g., "capture"). If targetWinSession is non-empty,
// only sessions in that Windows session are considered. Otherwise, the console
// session (physical monitor) is preferred over RDP sessions, and disconnected
// sessions are skipped.
//
// Uses the atomic snapshot to avoid holding b.mu.RLock() across OS API calls
// (GetConsoleSessionID, IsSessionDisconnected) that can block under system load.
// This prevents reader starvation of the heartbeat path when write-lock storms
// (reconnect loops) are in progress.
func (b *Broker) FindCapableSession(capability string, targetWinSession string) *Session {
	// snapshotSessions returns the atomic snapshot if available, or falls back
	// to a locked read for test fixtures. On the hot path the snapshot is always
	// available, so no lock is held during the OS calls below.
	sessions, _ := b.snapshotSessions()

	// When no target specified, prefer the console session (physical display).
	// NOTE: GetConsoleSessionID() is called outside any lock — safe because we
	// read from an immutable snapshot and no lock is needed for this OS call.
	if targetWinSession == "" || targetWinSession == "0" {
		targetWinSession = GetConsoleSessionID()
	}

	hasCapability := func(s *Session) bool {
		// GetCapabilities takes s.mu — required because the atomic snapshot
		// only protects the outer map identity, not per-session fields. A
		// direct read of s.Capabilities races with SetCapabilities writers
		// (which run under s.mu.Lock()) and trips -race under contention.
		caps := s.GetCapabilities()
		if caps == nil {
			return false
		}
		switch capability {
		case "capture":
			return caps.CanCapture
		case "clipboard":
			return caps.CanClipboard
		case "notify":
			return caps.CanNotify
		}
		return false
	}

	var best *Session

	// First pass: find a capable session in the target (console) session.
	for _, s := range sessions {
		if s.WinSessionID != targetWinSession {
			continue
		}
		if hasCapability(s) {
			if betterSession(s, best) {
				best = s
			}
		}
	}
	if best != nil {
		return best
	}

	// Second pass: fall back to any capable session that isn't disconnected.
	// IsSessionDisconnected makes a WTS syscall — safe outside any lock.
	for _, s := range sessions {
		if !hasCapability(s) {
			continue
		}
		if IsSessionDisconnected(s.WinSessionID) {
			continue
		}
		if betterSession(s, best) {
			best = s
		}
	}

	return best
}

// HasHelperForWinSession returns true if any connected helper is in the
// given Windows session.
func (b *Broker) HasHelperForWinSession(winSessionID string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.sessions {
		if s.WinSessionID == winSessionID {
			return true
		}
	}
	return false
}

// HasHelperForWinSessionRole returns true if a helper with the given role
// is connected in the specified Windows session.
func (b *Broker) HasHelperForWinSessionRole(winSessionID, role string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.sessions {
		if s.WinSessionID == winSessionID && s.HelperRole == role {
			return true
		}
	}
	return false
}

// FindUserSession returns the first connected session with HelperRole=="user"
// in the given Windows session. Used to route run_as_user scripts.
func (b *Broker) FindUserSession(winSessionID string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var best *Session
	for _, s := range b.sessions {
		if s.WinSessionID == winSessionID && s.HelperRole == ipc.HelperRoleUser && betterSession(s, best) {
			best = s
		}
	}
	return best
}

func (b *Broker) userHelperSessions() []*Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HelperRole == ipc.HelperRoleUser {
			sessions = append(sessions, s)
		}
	}
	return sessions
}

func (b *Broker) userHelperSessionForKey(sessionKey string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var best *Session
	for _, s := range b.sessions {
		if s.HelperRole != ipc.HelperRoleUser {
			continue
		}
		match := s.WinSessionID == sessionKey || s.IdentityKey == sessionKey
		if !match && s.UID > 0 {
			match = strconv.FormatUint(uint64(s.UID), 10) == sessionKey
		}
		if !match {
			continue
		}
		if betterSession(s, best) {
			best = s
		}
	}
	return best
}

// LaunchProcessViaUserHelper asks all connected user-role helpers to launch a
// binary. The helper is already running as the logged-in user, so the
// launched process inherits the user's identity and environment.
func (b *Broker) LaunchProcessViaUserHelper(binaryPath string) error {
	return b.LaunchProcessViaUserHelperWithArgs(binaryPath)
}

// LaunchProcessViaUserHelperWithArgs asks all connected user-role helpers to launch a
// binary with optional CLI args.
func (b *Broker) LaunchProcessViaUserHelperWithArgs(binaryPath string, args ...string) error {
	userSessions := b.userHelperSessions()
	if len(userSessions) == 0 {
		return fmt.Errorf("no user-role helper connected")
	}

	var launched int
	var errs []error
	for _, userSession := range userSessions {
		id := fmt.Sprintf("launch-%s-%d", userSession.SessionID, time.Now().UnixMilli())
		resp, err := userSession.SendCommand(id, ipc.TypeLaunchProcess,
			ipc.LaunchProcessRequest{BinaryPath: binaryPath, Args: args}, 15*time.Second)
		if err != nil {
			errs = append(errs, fmt.Errorf("session %s: launch_process IPC failed: %w", userSession.SessionID, err))
			continue
		}

		var result ipc.LaunchProcessResult
		if err := json.Unmarshal(resp.Payload, &result); err != nil {
			errs = append(errs, fmt.Errorf("session %s: unmarshal launch result: %w", userSession.SessionID, err))
			continue
		}
		if !result.OK {
			errs = append(errs, fmt.Errorf("session %s: user helper launch failed: %s", userSession.SessionID, result.Error))
			continue
		}

		launched++
		log.Info("process launched via user helper",
			"binary", binaryPath,
			"pid", result.PID,
			"sessionId", userSession.SessionID,
			"username", userSession.Username,
		)
	}

	if launched == 0 {
		return errors.Join(errs...)
	}
	return nil
}

// LaunchProcessViaUserHelperForSession asks the matching connected user-role helper
// to launch a binary for a specific session key. On Windows the key is the
// WinSessionID; on Unix it is the UID/identity key.
func (b *Broker) LaunchProcessViaUserHelperForSession(sessionKey, binaryPath string, args ...string) error {
	userSession := b.userHelperSessionForKey(sessionKey)
	if userSession == nil {
		return fmt.Errorf("no user-role helper connected for session %s", sessionKey)
	}

	id := fmt.Sprintf("launch-%s-%d", userSession.SessionID, time.Now().UnixMilli())
	resp, err := userSession.SendCommand(id, ipc.TypeLaunchProcess,
		ipc.LaunchProcessRequest{BinaryPath: binaryPath, Args: args}, 15*time.Second)
	if err != nil {
		return fmt.Errorf("session %s: launch_process IPC failed: %w", userSession.SessionID, err)
	}

	var result ipc.LaunchProcessResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return fmt.Errorf("session %s: unmarshal launch result: %w", userSession.SessionID, err)
	}
	if !result.OK {
		return fmt.Errorf("session %s: user helper launch failed: %s", userSession.SessionID, result.Error)
	}

	log.Info("process launched via user helper",
		"binary", binaryPath,
		"args", args,
		"pid", result.PID,
		"sessionId", userSession.SessionID,
		"username", userSession.Username,
	)
	return nil
}

// SendCommandAndWait forwards a command to a session and waits for the response.
func (b *Broker) SendCommandAndWait(session *Session, id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
	return session.SendCommand(id, cmdType, payload, timeout)
}

// sendPreAuthRejectAndClose wraps rawConn, sends a PreAuthReject envelope
// with a short write deadline so the broker isn't held up by a stuck client,
// then closes the connection. All errors are ignored — this is best-effort.
// The helper uses the envelope to distinguish fatal ("don't retry") from
// transient ("retry later") rejections.
func sendPreAuthRejectAndClose(rawConn net.Conn, code, reason string, permanent bool) {
	defer rawConn.Close()
	conn := ipc.NewConn(rawConn)
	_ = rawConn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := conn.SendTyped("pre-auth-reject", ipc.TypePreAuthReject, ipc.PreAuthReject{
		Code:      code,
		Reason:    reason,
		Permanent: permanent,
	}); err != nil && permanent {
		// When a permanent rejection can't be delivered, the helper won't know
		// to back off — it will interpret the dropped connection as a transient
		// error and resume retrying immediately (reconnect storm risk).
		log.Warn("failed to deliver permanent pre-auth rejection to helper",
			"code", code,
			"error", err.Error(),
		)
	}
}

// tryAdmitLocked decides whether a new connection for identityKey can be
// accepted. The caller must hold b.mu.Lock() for the full duration of this
// call and any subsequent registration step — otherwise concurrent admits
// for the same identity can each observe a stale `existing` slice and
// collectively push the count past MaxConnectionsPerIdentity.
//
// If under the cap, returns (true, nil). If at the cap and an idle victim
// over EvictIdleThreshold exists, removes the victim from b.sessions /
// b.byIdentity in place (atomic with the cap check) and returns (true,
// victim). If nothing evictable, returns (false, nil).
//
// The caller owns the returned victim and must Close() it outside the lock
// (Close() does I/O) and call onSessionClosed, if any.
func (b *Broker) tryAdmitLocked(identityKey string) (admitted bool, victim *Session) {
	existing := b.byIdentity[identityKey]
	if len(existing) < MaxConnectionsPerIdentity {
		return true, nil
	}

	var oldest time.Duration
	for _, s := range existing {
		idle := s.IdleDuration()
		if idle > EvictIdleThreshold && idle > oldest {
			victim = s
			oldest = idle
		}
	}
	if victim == nil {
		return false, nil
	}

	log.Warn("evicting idle session to admit reconnect",
		"identity", identityKey,
		"sessionId", victim.SessionID,
		"idleMs", oldest.Milliseconds(),
	)
	b.removeSessionMapsLocked(victim)
	return true, victim
}

// admitOrEvict is the pre-auth admission check called from handleConnection
// before the auth handshake runs, so DoS attempts are rejected cheaply.
// Caller must NOT hold b.mu. The register step later calls tryAdmitLocked
// again under its own write lock as the authoritative decision, so a race
// between this pre-check returning true and the register site cannot
// actually exceed the cap.
func (b *Broker) admitOrEvict(identityKey string) bool {
	b.mu.Lock()
	admitted, victim := b.tryAdmitLocked(identityKey)
	if victim != nil {
		b.publishSnapshotLocked()
	}
	onClosed := b.onSessionClosed
	b.mu.Unlock()

	if victim != nil {
		if err := victim.Close(); err != nil {
			log.Error("error closing evicted session",
				"sessionId", victim.SessionID,
				"error", err.Error(),
			)
		}
		if onClosed != nil {
			onClosed(victim)
		}
	}
	return admitted
}

func (b *Broker) handleConnection(rawConn net.Conn) {
	// Set handshake deadline
	rawConn.SetDeadline(time.Now().Add(HandshakeTimeout))

	// Step 1: Get peer credentials (kernel-enforced)
	creds, err := ipc.GetPeerCredentials(rawConn)
	if err != nil {
		log.Warn("peer credential check failed", "error", err.Error())
		sendPreAuthRejectAndClose(rawConn, ipc.PreAuthCodeCredCheckFailed, err.Error(), false)
		return
	}

	identityKey := creds.IdentityKey()

	// Step 2: Rate limit check (per identity: UID on Unix, SID on Windows)
	if !b.rateLimiter.Allow(identityKey) {
		log.Warn("connection rate limited", "identity", identityKey, "pid", creds.PID)
		sendPreAuthRejectAndClose(rawConn, ipc.PreAuthCodeRateLimited, "connection rate limited", false)
		return
	}

	// Step 3: Check max connections per identity. If the cap is hit, try to
	// evict a single stranded session (idle > EvictIdleThreshold) so a
	// reconnecting helper isn't permanently locked out by a dead predecessor.
	// This is the cheap pre-auth reject path; the register step below
	// re-runs the same check under a held write lock as the authoritative
	// decision. See issue #443.
	if !b.admitOrEvict(identityKey) {
		b.mu.RLock()
		identityCount := len(b.byIdentity[identityKey])
		b.mu.RUnlock()
		log.Warn("max connections exceeded", "identity", identityKey, "count", identityCount)
		sendPreAuthRejectAndClose(rawConn, ipc.PreAuthCodeMaxConnsExceeded, "too many connections for identity", false)
		return
	}

	// Wrap connection
	conn := ipc.NewConn(rawConn)

	// Step 4: Read auth request
	// (Moved ahead of binary-path verification so the hash from the auth
	// request can serve as the authoritative binary identity signal —
	// Windows cross-session spawns produce process paths that don't always
	// match our allowlist after path normalization. See issue #387 part D.)
	env, err := conn.Recv()
	if err != nil {
		log.Warn("auth request read failed", "identity", identityKey, "error", err.Error())
		conn.Close()
		return
	}

	if env.Type != ipc.TypeAuthRequest {
		log.Warn("expected auth_request, got", "type", env.Type)
		conn.Close()
		return
	}

	var authReq ipc.AuthRequest
	if err := json.Unmarshal(env.Payload, &authReq); err != nil {
		log.Warn("invalid auth request payload", "error", err.Error())
		conn.Close()
		return
	}

	// Step 5: Verify protocol version
	if authReq.ProtocolVersion != ipc.ProtocolVersion {
		log.Warn("protocol version mismatch", "got", authReq.ProtocolVersion, "want", ipc.ProtocolVersion)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted:  false,
			Reason:    fmt.Sprintf("unsupported protocol version %d (expected %d)", authReq.ProtocolVersion, ipc.ProtocolVersion),
			Permanent: true,
		})
		conn.Close()
		return
	}

	// Step 6: Verify identity — SID on Windows, UID on Unix.
	// The watchdog role is exempt from identity claim validation: it runs
	// as SYSTEM but its IPCClient doesn't self-report a SID or a usable
	// UID (Go's os.Getuid() returns -1 on Windows → uint32 overflow).
	// The kernel-verified creds from GetPeerCredentials (step 1) are
	// sufficient — a caller can't fake them on a named pipe / Unix socket.
	if authReq.HelperRole != ipc.HelperRoleWatchdog {
		if runtime.GOOS == "windows" {
			if authReq.SID == "" {
				log.Warn("auth missing SID on Windows", "pid", creds.PID)
				_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
					Accepted:  false,
					Reason:    "SID required on Windows",
					Permanent: true,
				})
				conn.Close()
				return
			}
			if authReq.SID != creds.SID {
				log.Warn("auth SID mismatch", "claimed", authReq.SID, "actual", creds.SID)
				_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
					Accepted:  false,
					Reason:    "SID mismatch",
					Permanent: true,
				})
				conn.Close()
				return
			}
		} else {
			if authReq.UID != creds.UID {
				log.Warn("auth UID mismatch", "claimed", authReq.UID, "actual", creds.UID)
				_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
					Accepted:  false,
					Reason:    "UID mismatch",
					Permanent: true,
				})
				conn.Close()
				return
			}
		}
	}

	// Step 7: Verify binary hash — reject helpers if no allowed helper hash could be loaded.
	if len(b.selfHashes) == 0 {
		log.Error("rejecting helper connection: helper binary hash allowlist unavailable",
			"identity", identityKey,
			"pid", creds.PID,
		)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted:  false,
			Reason:    "helper binary hash allowlist unavailable",
			Permanent: true,
		})
		conn.Close()
		return
	}
	hashVerified := b.isAllowedBinaryHash(authReq.BinaryHash)
	if !hashVerified {
		allowed := make([]string, 0, len(b.selfHashes))
		for h := range b.selfHashes {
			allowed = append(allowed, h)
		}
		log.Warn("binary hash mismatch",
			"identity", identityKey,
			"expected", allowed,
			"got", authReq.BinaryHash,
		)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted:  false,
			Reason:    "binary hash mismatch",
			Permanent: true,
		})
		conn.Close()
		return
	}

	// Step 8: Verify binary path (defense in depth). If the hash already
	// matched the allowlist (step 7), the binary is trusted regardless of path
	// — on Windows, CreateProcessAsUser can report paths that don't match after
	// normalization (8.3 short names, drive letter case, etc.), and the hash
	// is the authoritative identity check. Log the path mismatch at DEBUG for
	// future investigation, but do not reject; a hash-verified helper is safe.
	if !b.verifyBinaryPath(creds.BinaryPath) {
		log.Debug("binary path mismatch but hash verified; accepting",
			"identity", identityKey,
			"pid", creds.PID,
			"path", creds.BinaryPath,
			"allowed", b.allowedHelperPaths(),
		)
	}

	// Step 9: Reject duplicate session IDs
	b.mu.RLock()
	if _, exists := b.sessions[authReq.SessionID]; exists {
		b.mu.RUnlock()
		log.Warn("duplicate session ID", "sessionId", authReq.SessionID, "identity", identityKey)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   "session ID already in use",
		})
		conn.Close()
		return
	}
	b.mu.RUnlock()

	// Generate session key
	sessionKey, err := ipc.GenerateSessionKey()
	if err != nil {
		log.Error("failed to generate session key", "error", err.Error())
		conn.Close()
		return
	}

	// Determine helper role and scopes. Default to "system" for backward compat
	// with helpers that don't send the role field.
	helperRole := authReq.HelperRole
	if helperRole == "" {
		helperRole = ipc.HelperRoleSystem
	}

	// Step 10: Validate role matches peer identity to prevent privilege escalation.
	// On Windows, SYSTEM helpers must run as SYSTEM (S-1-5-18), and user helpers
	// must NOT run as SYSTEM. This prevents a non-SYSTEM process from claiming
	// system role to get desktop scopes, or SYSTEM from claiming user role.
	// The watchdog must also run as root/SYSTEM.
	const systemSID = "S-1-5-18"
	if runtime.GOOS == "windows" {
		if helperRole == ipc.HelperRoleSystem && creds.SID != systemSID {
			log.Warn("role/identity mismatch: non-SYSTEM process claiming system role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    "system role requires SYSTEM identity",
				Permanent: true,
			})
			conn.Close()
			return
		}
		if helperRole == ipc.HelperRoleUser && creds.SID == systemSID {
			log.Warn("role/identity mismatch: SYSTEM process claiming user role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    "user role requires non-SYSTEM identity",
				Permanent: true,
			})
			conn.Close()
			return
		}
		if helperRole == ipc.HelperRoleWatchdog && creds.SID != systemSID {
			log.Warn("role/identity mismatch: non-SYSTEM process claiming watchdog role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    "watchdog role requires SYSTEM identity",
				Permanent: true,
			})
			conn.Close()
			return
		}
	} else {
		// Unix: watchdog must run as root (UID 0).
		if helperRole == ipc.HelperRoleWatchdog && creds.UID != 0 {
			log.Warn("role/identity mismatch: non-root process claiming watchdog role",
				"uid", creds.UID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    "watchdog role requires root identity",
				Permanent: true,
			})
			conn.Close()
			return
		}
	}

	var scopes []string
	switch helperRole {
	case ipc.HelperRoleUser:
		scopes = userHelperScopes
	case backupipc.HelperRoleBackup:
		scopes = backupHelperScopes
	case ipc.HelperRoleWatchdog:
		scopes = watchdogHelperScopes
	default:
		helperRole = ipc.HelperRoleSystem
		scopes = systemHelperScopes
	}

	// Send auth response
	authResp := ipc.AuthResponse{
		Accepted:      true,
		SessionKey:    hex.EncodeToString(sessionKey),
		AllowedScopes: scopes,
	}
	if err := conn.SendTyped(env.ID, ipc.TypeAuthResponse, authResp); err != nil {
		log.Warn("failed to send auth response", "error", err.Error())
		conn.Close()
		return
	}

	// Set session key for HMAC validation
	conn.SetSessionKey(sessionKey)

	// Clear the handshake deadline
	rawConn.SetDeadline(time.Time{})

	// Create session
	session := NewSession(conn, creds.UID, identityKey, authReq.Username, authReq.DisplayEnv, authReq.SessionID, scopes)
	session.PID = int(creds.PID)
	session.HelperRole = helperRole
	session.BinaryKind = authReq.BinaryKind
	if session.BinaryKind == "" {
		session.BinaryKind = ipc.HelperBinaryUserHelper
	}
	session.DesktopContext = authReq.DesktopContext

	// Use kernel-verified Windows session ID (from peer PID) instead of
	// trusting the self-reported value, preventing session-jumping attacks.
	if verifiedSID := peerWinSessionID(creds.PID); verifiedSID != 0 {
		session.WinSessionID = fmt.Sprintf("%d", verifiedSID)
		if verifiedSID != authReq.WinSessionID {
			log.Warn("WinSessionID mismatch — using kernel-verified value",
				"reported", authReq.WinSessionID,
				"verified", verifiedSID,
				"pid", creds.PID,
			)
		}
	} else {
		session.WinSessionID = fmt.Sprintf("%d", authReq.WinSessionID)
	}

	// Register session. Re-run tryAdmitLocked under the write lock: this
	// is the authoritative cap check. Without it, two concurrent admits
	// for the same identity could both pass admitOrEvict (or both see
	// room after one of them evicted), then both append here and push the
	// count past MaxConnectionsPerIdentity. Also captures any victim so we
	// can Close() it outside the lock below.
	b.mu.Lock()
	admitted, victim := b.tryAdmitLocked(identityKey)
	if !admitted {
		b.mu.Unlock()
		log.Warn("max connections exceeded at register (admit race)",
			"identity", identityKey,
			"sessionId", authReq.SessionID,
		)
		conn.Close()
		return
	}
	b.sessions[authReq.SessionID] = session
	b.byIdentity[identityKey] = append(b.byIdentity[identityKey], session)
	// Track backup helper session for direct access
	if helperRole == backupipc.HelperRoleBackup {
		if b.backup == nil {
			b.backup = &backupHelper{}
		}
		b.backup.session = session
	}
	b.publishSnapshotLocked()
	registerOnClosed := b.onSessionClosed
	b.mu.Unlock()

	if victim != nil {
		if err := victim.Close(); err != nil {
			log.Error("error closing evicted session at register",
				"sessionId", victim.SessionID,
				"error", err.Error(),
			)
		}
		if registerOnClosed != nil {
			registerOnClosed(victim)
		}
	}

	log.Info("user helper connected",
		"identity", identityKey,
		"username", authReq.Username,
		"sessionId", authReq.SessionID,
		"display", authReq.DisplayEnv,
		"pid", creds.PID,
		"role", helperRole,
		"binaryKind", session.BinaryKind,
		"desktopContext", session.DesktopContext,
	)

	// Keepalive: send periodic pings and close the session if pongs stop
	// arriving. Without this, a wedged helper (e.g. a capture process killed
	// mid-stream) can hold a slot forever because RecvLoop blocks on a read
	// with no deadline. See issue #443. Watchdog is exempt — see
	// roleSupportsKeepalive.
	b.maybeStartKeepalive(session, helperRole)

	// Start receive loop — blocks until disconnect
	session.RecvLoop(b.dispatchHelperMessage)

	// Clean up after disconnect
	b.removeSession(session)
	if session.HelperRole == backupipc.HelperRoleBackup {
		b.ClearBackupSession()
	}
	log.Info("user helper disconnected", "uid", session.UID, "sessionId", session.SessionID)
}

// removeSessionMapsLocked removes session from b.sessions and b.byIdentity
// and records the PID as stale. Caller must hold b.mu.Lock(). Does NOT
// Close() the session, publish a snapshot, or fire onSessionClosed; the
// caller is responsible for those.
func (b *Broker) removeSessionMapsLocked(session *Session) {
	delete(b.sessions, session.SessionID)

	key := session.IdentityKey
	sessions := b.byIdentity[key]
	for i, s := range sessions {
		if s == session {
			b.byIdentity[key] = append(sessions[:i], sessions[i+1:]...)
			break
		}
	}
	if len(b.byIdentity[key]) == 0 {
		delete(b.byIdentity, key)
	}

	// Track the PID so we can kill it before spawning a replacement.
	// Don't kill here — the process may still be serving an active desktop session.
	// Key includes role so SYSTEM and user helper stale PIDs are tracked separately.
	if session.PID > 0 {
		staleKey := session.WinSessionID + "-" + session.HelperRole
		b.trackStaleHelper(staleKey, session.PID)
	}
}

func (b *Broker) removeSession(session *Session) {
	b.mu.Lock()
	b.removeSessionMapsLocked(session)
	b.publishSnapshotLocked()
	onSessionClosed := b.onSessionClosed
	b.mu.Unlock()

	if onSessionClosed != nil {
		onSessionClosed(session)
	}
}

// trackStaleHelper records a disconnected helper PID for later cleanup.
// Called under b.mu lock.
func (b *Broker) trackStaleHelper(winSessionID string, pid int) {
	b.staleHelpers[winSessionID] = append(b.staleHelpers[winSessionID], pid)
}

// KillStaleHelpers kills any disconnected helper processes for the given
// Windows session. Call this before spawning a new helper to release DXGI
// Desktop Duplication locks held by orphaned processes.
func (b *Broker) KillStaleHelpers(winSessionID string) {
	b.mu.Lock()
	pids := b.staleHelpers[winSessionID]
	delete(b.staleHelpers, winSessionID)
	b.mu.Unlock()

	for _, pid := range pids {
		if proc, err := os.FindProcess(pid); err == nil {
			if err := proc.Kill(); err != nil {
				log.Debug("failed to kill stale userhelper (may have already exited)",
					"pid", pid, "error", err.Error())
			} else {
				log.Info("killed stale userhelper before respawn",
					"pid", pid, "winSessionID", winSessionID)
			}
		}
	}
}

// CloseSessionsByDesktopContext closes all sessions with the given desktop
// context (e.g., "user_session"). Used on macOS to tear down stale helpers
// after a logout event. Returns the number of sessions closed.
//
// Note: this method iterates b.sessions under b.mu.Lock() and queues matching
// sessions into a local slice before releasing the lock and calling Close on
// each one. Because the atomic snapshot is NOT refreshed until removeSession
// runs (via the RecvLoop exit path for each closed session), snapshot-path
// readers may briefly see closed sessions during that window. This is an
// acceptable trade-off: Close() is idempotent, and the calling code tolerates
// a best-effort teardown on macOS logout.
func (b *Broker) CloseSessionsByDesktopContext(ctx string) int {
	b.mu.Lock()
	var toClose []*Session
	for _, s := range b.sessions {
		if s.DesktopContext == ctx {
			toClose = append(toClose, s)
		}
	}
	b.mu.Unlock()

	for _, s := range toClose {
		if err := s.Close(); err != nil {
			log.Debug("failed to close session by desktop context",
				"sessionId", s.SessionID,
				"desktopContext", ctx,
				"error", err.Error())
		}
	}
	return len(toClose)
}

// setupSocket is implemented in broker_windows.go and broker_unix.go.

func (b *Broker) verifyBinaryPath(peerPath string) bool {
	peerResolved, err := filepath.EvalSymlinks(peerPath)
	if err != nil {
		// Peer path might not be resolvable if the process has exited
		peerResolved = peerPath
	}
	peerResolved = normalizeBinaryPath(filepath.Clean(peerResolved))
	allowed := b.allowedHelperPaths()
	for _, candidate := range allowed {
		if normalizeBinaryPath(filepath.Clean(candidate)) == peerResolved {
			return true
		}
	}
	// Log the mismatch at DEBUG so investigators can see exactly which
	// paths the broker considered trusted. Cheap and load-bearing.
	log.Debug("verifyBinaryPath: no match",
		"peer", peerResolved,
		"allowed", allowed,
	)
	return false
}

func (b *Broker) allowedHelperPaths() []string {
	exePath, err := os.Executable()
	if err != nil {
		if runtime.GOOS == "windows" {
			// On Windows all trusted paths are derived from the exe location;
			// without it we cannot determine any safe paths.
			log.Warn("failed to get executable path; no helper paths available", "error", err.Error())
			return []string{}
		}
		log.Warn("failed to get executable path, falling back to hardcoded helper paths", "error", err.Error())
		return []string{
			"/usr/local/bin/breeze-agent",
			"/usr/local/bin/breeze-desktop-helper",
			"/usr/local/bin/breeze-watchdog",
		}
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		exePath = filepath.Clean(exePath)
	}
	dir := filepath.Dir(exePath)
	paths := []string{
		exePath,
		filepath.Join(dir, "breeze-desktop-helper"),
		filepath.Join(dir, "breeze-watchdog"),
		filepath.Join(dir, "breeze-desktop-helper.exe"),
		filepath.Join(dir, "breeze-watchdog.exe"),
	}
	if runtime.GOOS != "windows" {
		paths = append(paths,
			"/usr/local/bin/breeze-agent",
			"/usr/local/bin/breeze-desktop-helper",
			"/usr/local/bin/breeze-watchdog",
		)
	}
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		clean := filepath.Clean(path)
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
	}
	return out
}

// RefreshAllowedHashes recomputes the helper binary hash allowlist from the
// binaries currently present on disk. Call this after a dev push that
// replaces a helper binary so the next connection from the newly spawned
// helper (which will hash to a new value) is accepted.
func (b *Broker) RefreshAllowedHashes() {
	newHashes := b.computeAllowedHashes()
	b.mu.Lock()
	b.selfHashes = newHashes
	b.mu.Unlock()
	log.Info("refreshed helper binary hash allowlist", "count", len(newHashes))
}

func (b *Broker) computeAllowedHashes() map[string]struct{} {
	hashes := make(map[string]struct{})
	for _, path := range b.allowedHelperPaths() {
		sum, err := hashFileSHA256(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				log.Debug("allowed helper binary not present", "path", path)
			} else {
				log.Warn("failed to hash allowed helper binary", "path", path, "error", err.Error())
			}
			continue
		}
		hashes[sum] = struct{}{}
	}
	if len(hashes) == 0 {
		log.Error("no valid helper binary hashes could be computed; all helper connections will be rejected")
	}
	return hashes
}

func (b *Broker) isAllowedBinaryHash(hash string) bool {
	if hash == "" {
		return false
	}
	_, ok := b.selfHashes[hash]
	return ok
}

func hashFileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("path is not a regular file")
	}

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// dispatchHelperMessage is the RecvLoop callback for an authed helper
// session. Extracted from the handleConnection closure so keepalive/pong
// tests can drive the real dispatch through a paired ipc.Conn without
// replicating the switch.
func (b *Broker) dispatchHelperMessage(s *Session, env *ipc.Envelope) {
	switch env.Type {
	case ipc.TypePing:
		if err := s.conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
			log.Warn("failed to send pong", "uid", s.UID, "error", err.Error())
			return
		}
	case ipc.TypePong:
		// Reply to broker-initiated keepalive ping. RecvLoop has already
		// called s.Touch(), so the idle reaper won't claim this session.
		s.NotePong()
	case ipc.TypeCapabilities:
		var caps ipc.Capabilities
		if err := json.Unmarshal(env.Payload, &caps); err != nil {
			log.Warn("invalid capabilities payload", "uid", s.UID, "error", err.Error())
		} else {
			sanitized := sanitizeCapabilitiesForSession(s, &caps)
			s.SetCapabilities(sanitized)
			// Log from the locally-held copy to avoid a post-Set read of
			// s.Capabilities that would race with any concurrent reader.
			log.Info("capabilities received",
				"uid", s.UID,
				"canNotify", sanitized.CanNotify,
				"canTray", sanitized.CanTray,
				"canCapture", sanitized.CanCapture,
				"canClipboard", sanitized.CanClipboard,
				"displayServer", sanitized.DisplayServer,
			)
		}
	case ipc.TypeTCCStatus:
		var status ipc.TCCStatus
		if err := json.Unmarshal(env.Payload, &status); err != nil {
			log.Warn("invalid tcc_status payload", "uid", s.UID, "error", err.Error())
		} else {
			sanitized := sanitizeTCCStatusForSession(s, &status)
			if sanitized == nil {
				log.Warn("dropping unauthorized tcc_status message",
					"sessionId", s.SessionID, "role", s.HelperRole)
				return
			}
			s.SetTCCStatus(sanitized)
			log.Info("TCC permissions received",
				"uid", s.UID,
				"screenRecording", sanitized.ScreenRecording,
				"accessibility", sanitized.Accessibility,
				"fullDiskAccess", sanitized.FullDiskAccess,
				"remoteDesktop", sanitized.RemoteDesktop,
			)
		}
	case ipc.TypeDisconnect:
		log.Info("user helper disconnecting", "uid", s.UID, "sessionId", s.SessionID)
		s.Close()
	case ipc.TypeWatchdogPing:
		if !s.HasScope("watchdog") {
			log.Warn("dropping watchdog_ping from non-watchdog session",
				"sessionId", s.SessionID, "role", s.HelperRole)
			return
		}
		var ping ipc.WatchdogPing
		if err := json.Unmarshal(env.Payload, &ping); err != nil {
			log.Warn("invalid watchdog_ping payload", "error", err.Error())
			return
		}
		pong := ipc.WatchdogPong{
			Healthy: true,
			Uptime:  int64(time.Since(b.startTime).Seconds()),
		}
		if ping.RequestHealthSummary && b.onMessage != nil {
			// Health summary is populated by the heartbeat module via onMessage;
			// for the broker-level ping we include uptime only.
		}
		if err := s.SendNotify(env.ID, ipc.TypeWatchdogPong, pong); err != nil {
			log.Warn("failed to send watchdog_pong", "error", err.Error())
		}
	case ipc.TypeWatchdogCommandResult:
		if !shouldForwardUnsolicitedHelperMessage(s, env) {
			log.Warn("dropping unauthorized watchdog_command_result",
				"sessionId", s.SessionID, "role", s.HelperRole)
			return
		}
		if b.onMessage != nil {
			b.onMessage(s, env)
		}
	case backupipc.TypeBackupResult, backupipc.TypeBackupProgress, backupipc.TypeBackupReady:
		if !shouldForwardUnsolicitedHelperMessage(s, env) {
			log.Warn("dropping unauthorized backup helper message",
				"type", env.Type, "sessionId", s.SessionID, "role", s.HelperRole)
			return
		}
		if b.onMessage != nil {
			b.onMessage(s, env)
		}
	case ipc.TypeTrayAction, ipc.TypeNotifyResult, ipc.TypeClipboardData, ipc.TypeCommandResult, ipc.TypeSASRequest, ipc.TypeDesktopPeerDisconnected,
		ipc.TypeDesktopStart, ipc.TypeDesktopStop, ipc.TypeLaunchResult:
		if !shouldForwardUnsolicitedHelperMessage(s, env) {
			log.Warn("dropping unsolicited or unauthorized helper message",
				"type", env.Type, "sessionId", s.SessionID, "role", s.HelperRole)
			return
		}
		if b.onMessage != nil {
			b.onMessage(s, env)
		}
	default:
		log.Warn("unknown message type from helper, ignoring",
			"type", env.Type, "identity", s.IdentityKey, "sessionId", s.SessionID)
	}
}

// keepaliveMaxSendFailures is the number of consecutive ping sends that may
// fail before runKeepalive gives up and closes the session. A single failure
// can be a transient EAGAIN on a full socket buffer or a slow drain — the
// real "helper is wedged" signal is the pong-age check, not the send side.
const keepaliveMaxSendFailures = 3

// runKeepalive pings the helper every keepalivePingInterval and closes the
// session if no pong has arrived for keepaliveTimeout. Exits when the session
// is closed by anything else (RecvLoop return, explicit Close, reaper, etc).
//
// Order inside the ticker branch is `check age → send ping`, not the other
// way around. If we sent first and then checked age, a tick that happens to
// straddle a just-arriving pong would read a stale "previous pong" age and
// spuriously close a healthy session. Checking first means we only close
// when the most recent pong we actually have is already too old — a
// decision that is independent of this tick's outgoing ping.
func (b *Broker) runKeepalive(session *Session) {
	ticker := time.NewTicker(keepalivePingInterval)
	defer ticker.Stop()

	sendFailures := 0
	for {
		select {
		case <-session.Done():
			return
		case <-ticker.C:
			if session.IsClosed() {
				return
			}

			// Authoritative wedge check: the age here is the time since the
			// most recently received pong (seeded to session creation time
			// in NewSession), not the time since the ping we're about to
			// send below.
			if age := session.LastPongAge(); age > keepaliveTimeout {
				log.Warn("keepalive pong timeout, closing stranded session",
					"sessionId", session.SessionID,
					"identity", session.IdentityKey,
					"ageMs", age.Milliseconds(),
				)
				if err := session.Close(); err != nil {
					log.Error("keepalive close returned error",
						"sessionId", session.SessionID,
						"error", err.Error(),
					)
				}
				return
			}

			// Send is mutex-serialised by ipc.Conn (see protocol.go), so
			// this is safe to call concurrently with RecvLoop/SendCommand
			// paths.
			if err := session.conn.SendTyped("keepalive", ipc.TypePing, nil); err != nil {
				sendFailures++
				log.Warn("keepalive ping send failed",
					"sessionId", session.SessionID,
					"identity", session.IdentityKey,
					"consecutive", sendFailures,
					"error", err.Error(),
				)
				if sendFailures >= keepaliveMaxSendFailures {
					log.Warn("keepalive ping send failed repeatedly, closing session",
						"sessionId", session.SessionID,
						"identity", session.IdentityKey,
						"consecutive", sendFailures,
					)
					if err := session.Close(); err != nil {
						log.Error("keepalive close returned error",
							"sessionId", session.SessionID,
							"error", err.Error(),
						)
					}
					return
				}
				continue
			}
			sendFailures = 0
		}
	}
}

func (b *Broker) idleReaper(stopChan <-chan struct{}) {
	ticker := time.NewTicker(IdleCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.reapIdleSessions()
		case <-stopChan:
			return
		}
	}
}

func (b *Broker) reapIdleSessions() {
	b.mu.RLock()
	var toClose []*Session
	for _, s := range b.sessions {
		// CanCapture is no longer exempt: a streaming helper touches the
		// session on every frame, so a capture session only reaches
		// IdleTimeout if its helper is stranded (killed pipe / WER hang).
		// See issue #443.
		if s.IdleDuration() > IdleTimeout {
			toClose = append(toClose, s)
		}
	}
	b.mu.RUnlock()

	for _, s := range toClose {
		log.Info("disconnecting idle user helper", "uid", s.UID, "sessionId", s.SessionID, "idle", s.IdleDuration())
		s.Close()
		b.removeSession(s)
	}
}

func betterSession(candidate, current *Session) bool {
	if candidate == nil {
		return false
	}
	if current == nil {
		return true
	}
	if candidate.LastSeen.After(current.LastSeen) {
		return true
	}
	if current.LastSeen.After(candidate.LastSeen) {
		return false
	}
	if candidate.ConnectedAt.After(current.ConnectedAt) {
		return true
	}
	if current.ConnectedAt.After(candidate.ConnectedAt) {
		return false
	}
	return candidate.SessionID < current.SessionID
}

func betterDesktopSession(candidate, current *Session) bool {
	if candidate == nil {
		return false
	}
	if current == nil {
		return true
	}
	if candidate.BinaryKind == ipc.HelperBinaryDesktopHelper && current.BinaryKind != ipc.HelperBinaryDesktopHelper {
		return true
	}
	if candidate.BinaryKind != ipc.HelperBinaryDesktopHelper && current.BinaryKind == ipc.HelperBinaryDesktopHelper {
		return false
	}
	if candidate.DesktopContext == ipc.DesktopContextUserSession && current.DesktopContext != ipc.DesktopContextUserSession {
		return true
	}
	if candidate.DesktopContext != ipc.DesktopContextUserSession && current.DesktopContext == ipc.DesktopContextUserSession {
		return false
	}
	if candidate.DesktopContext == ipc.DesktopContextLoginWindow && current.DesktopContext == "" {
		return true
	}
	if candidate.DesktopContext == "" && current.DesktopContext == ipc.DesktopContextLoginWindow {
		return false
	}
	return betterSession(candidate, current)
}

func shouldForwardUnsolicitedHelperMessage(session *Session, env *ipc.Envelope) bool {
	switch env.Type {
	case backupipc.TypeBackupResult, backupipc.TypeBackupProgress, backupipc.TypeBackupReady:
		return session.HasScope("backup")
	case ipc.TypeTrayAction:
		return session.HasScope("tray")
	case ipc.TypeSASRequest, ipc.TypeDesktopPeerDisconnected:
		return session.HasScope("desktop")
	case ipc.TypeWatchdogCommandResult:
		return session.HasScope("watchdog")
	case ipc.TypeNotifyResult, ipc.TypeClipboardData, ipc.TypeCommandResult:
		return false
	default:
		return false
	}
}

func sanitizeCapabilitiesForSession(session *Session, caps *ipc.Capabilities) *ipc.Capabilities {
	if caps == nil {
		return nil
	}
	sanitized := *caps
	sanitized.DisplayServer = truncateSessionString(sanitized.DisplayServer, 64)
	if session == nil {
		return &sanitized
	}
	if !session.HasScope("notify") {
		sanitized.CanNotify = false
	}
	if !session.HasScope("tray") {
		sanitized.CanTray = false
	}
	if !session.HasScope("desktop") {
		sanitized.CanCapture = false
	}
	if !session.HasScope("clipboard") {
		sanitized.CanClipboard = false
	}
	return &sanitized
}

func sanitizeTCCStatusForSession(session *Session, status *ipc.TCCStatus) *ipc.TCCStatus {
	if status == nil {
		return nil
	}
	if session != nil && !session.HasScope("desktop") {
		return nil
	}
	sanitized := *status
	return &sanitized
}

func truncateSessionString(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return strings.TrimSpace(value[:max]) + "... [truncated]"
}
