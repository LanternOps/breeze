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
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	// HandshakeTimeout is the deadline for completing auth after connecting.
	HandshakeTimeout = 5 * time.Second

	// IdleTimeout disconnects helpers that send no messages for this duration.
	IdleTimeout = 30 * time.Minute

	// MaxConnectionsPerIdentity limits concurrent connections per user identity.
	MaxConnectionsPerIdentity = 3

	// RateLimitAttempts is max connection attempts per identity per window.
	RateLimitAttempts = 5

	// RateLimitWindow is the sliding window for rate limiting.
	RateLimitWindow = 60 * time.Second

	// IdleCheckInterval is how often to scan for idle sessions.
	IdleCheckInterval = 60 * time.Second
)

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

// Broker manages IPC connections from user helper processes.
type Broker struct {
	socketPath  string
	listener    net.Listener
	rateLimiter *ipc.RateLimiter
	startTime   time.Time // broker creation time, used for watchdog uptime

	mu           sync.RWMutex
	sessions     map[string]*Session   // sessionID -> Session
	byIdentity   map[string][]*Session // identity key -> Sessions (UID string on Unix, SID on Windows)
	staleHelpers map[string][]int      // winSessionID -> PIDs of disconnected helpers
	consoleUser  string                // macOS: current console user ("loginwindow" at login screen)
	backup       *backupHelper         // backup helper process and session
	closed       bool

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
	return b
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
	b.consoleUser = username
	b.mu.Unlock()
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
func (b *Broker) AllSessions() []SessionInfo {
	b.mu.RLock()
	defer b.mu.RUnlock()
	infos := make([]SessionInfo, 0, len(b.sessions))
	for _, s := range b.sessions {
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

func (b *Broker) preferredDesktopSessionLocked() *Session {
	atLoginWindow := b.consoleUser == "loginwindow"

	var best *Session
	for _, s := range b.sessions {
		if !s.HasScope("desktop") {
			continue
		}
		if s.Capabilities == nil || !s.Capabilities.CanCapture {
			continue
		}
		// On macOS at the login screen, skip user_session helpers if a
		// login_window helper is available.
		if atLoginWindow && s.DesktopContext == ipc.DesktopContextUserSession &&
			best != nil && best.DesktopContext == ipc.DesktopContextLoginWindow {
			continue
		}
		if atLoginWindow && best != nil && best.DesktopContext == ipc.DesktopContextUserSession &&
			s.DesktopContext == ipc.DesktopContextLoginWindow {
			best = s
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
func (b *Broker) TCCStatus() *ipc.TCCStatus {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if preferred := b.preferredDesktopSessionLocked(); preferred != nil {
		if tcc := preferred.GetTCCStatus(); tcc != nil {
			cp := *tcc
			return &cp
		}
	}

	for _, s := range b.sessions {
		if !s.HasScope("desktop") {
			continue
		}
		if tcc := s.GetTCCStatus(); tcc != nil {
			cp := *tcc
			return &cp
		}
	}

	for _, s := range b.sessions {
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

// SessionCount returns the number of active sessions.
func (b *Broker) SessionCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.sessions)
}

// FindCapableSession returns the best connected session whose helper reports
// the given capability (e.g., "capture"). If targetWinSession is non-empty,
// only sessions in that Windows session are considered. Otherwise, the console
// session (physical monitor) is preferred over RDP sessions, and disconnected
// sessions are skipped.
func (b *Broker) FindCapableSession(capability string, targetWinSession string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	// When no target specified, prefer the console session (physical display).
	if targetWinSession == "" || targetWinSession == "0" {
		targetWinSession = GetConsoleSessionID()
	}

	hasCapability := func(s *Session) bool {
		if s.Capabilities == nil {
			return false
		}
		switch capability {
		case "capture":
			return s.Capabilities.CanCapture
		case "clipboard":
			return s.Capabilities.CanClipboard
		case "notify":
			return s.Capabilities.CanNotify
		}
		return false
	}

	var best *Session

	// First pass: find a capable session in the target (console) session.
	for _, s := range b.sessions {
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
	for _, s := range b.sessions {
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

func (b *Broker) handleConnection(rawConn net.Conn) {
	// Set handshake deadline
	rawConn.SetDeadline(time.Now().Add(HandshakeTimeout))

	// Step 1: Get peer credentials (kernel-enforced)
	creds, err := ipc.GetPeerCredentials(rawConn)
	if err != nil {
		log.Warn("peer credential check failed", "error", err.Error())
		rawConn.Close()
		return
	}

	identityKey := creds.IdentityKey()

	// Step 2: Rate limit check (per identity: UID on Unix, SID on Windows)
	if !b.rateLimiter.Allow(identityKey) {
		log.Warn("connection rate limited", "identity", identityKey, "pid", creds.PID)
		rawConn.Close()
		return
	}

	// Step 3: Check max connections per identity
	b.mu.RLock()
	identityCount := len(b.byIdentity[identityKey])
	b.mu.RUnlock()
	if identityCount >= MaxConnectionsPerIdentity {
		log.Warn("max connections exceeded", "identity", identityKey, "count", identityCount)
		rawConn.Close()
		return
	}

	// Step 4: Verify binary path
	if !b.verifyBinaryPath(creds.BinaryPath) {
		log.Warn("binary path verification failed",
			"identity", identityKey,
			"pid", creds.PID,
			"path", creds.BinaryPath,
		)
		rawConn.Close()
		return
	}

	// Wrap connection
	conn := ipc.NewConn(rawConn)

	// Step 5: Read auth request
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

	// Step 6: Verify protocol version
	if authReq.ProtocolVersion != ipc.ProtocolVersion {
		log.Warn("protocol version mismatch", "got", authReq.ProtocolVersion, "want", ipc.ProtocolVersion)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   fmt.Sprintf("unsupported protocol version %d (expected %d)", authReq.ProtocolVersion, ipc.ProtocolVersion),
		})
		conn.Close()
		return
	}

	// Step 7: Verify identity — SID on Windows, UID on Unix
	if runtime.GOOS == "windows" {
		if authReq.SID == "" {
			log.Warn("auth missing SID on Windows", "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted: false,
				Reason:   "SID required on Windows",
			})
			conn.Close()
			return
		}
		if authReq.SID != creds.SID {
			log.Warn("auth SID mismatch", "claimed", authReq.SID, "actual", creds.SID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted: false,
				Reason:   "SID mismatch",
			})
			conn.Close()
			return
		}
	} else {
		if authReq.UID != creds.UID {
			log.Warn("auth UID mismatch", "claimed", authReq.UID, "actual", creds.UID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted: false,
				Reason:   "UID mismatch",
			})
			conn.Close()
			return
		}
	}

	// Step 8: Verify binary hash — reject helpers if no allowed helper hash could be loaded.
	if len(b.selfHashes) == 0 {
		log.Error("rejecting helper connection: helper binary hash allowlist unavailable",
			"identity", identityKey,
			"pid", creds.PID,
		)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   "helper binary hash allowlist unavailable",
		})
		conn.Close()
		return
	}
	if !b.isAllowedBinaryHash(authReq.BinaryHash) {
		log.Warn("binary hash mismatch",
			"identity", identityKey,
			"expected", "allowed-helper-binary",
			"got", authReq.BinaryHash,
		)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   "binary hash mismatch",
		})
		conn.Close()
		return
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
				Accepted: false,
				Reason:   "system role requires SYSTEM identity",
			})
			conn.Close()
			return
		}
		if helperRole == ipc.HelperRoleUser && creds.SID == systemSID {
			log.Warn("role/identity mismatch: SYSTEM process claiming user role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted: false,
				Reason:   "user role requires non-SYSTEM identity",
			})
			conn.Close()
			return
		}
		if helperRole == ipc.HelperRoleWatchdog && creds.SID != systemSID {
			log.Warn("role/identity mismatch: non-SYSTEM process claiming watchdog role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted: false,
				Reason:   "watchdog role requires SYSTEM identity",
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
				Accepted: false,
				Reason:   "watchdog role requires root identity",
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

	// Register session
	b.mu.Lock()
	b.sessions[authReq.SessionID] = session
	b.byIdentity[identityKey] = append(b.byIdentity[identityKey], session)
	// Track backup helper session for direct access
	if helperRole == backupipc.HelperRoleBackup {
		if b.backup == nil {
			b.backup = &backupHelper{}
		}
		b.backup.session = session
	}
	b.mu.Unlock()

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

	// Start receive loop — blocks until disconnect
	session.RecvLoop(func(s *Session, env *ipc.Envelope) {
		switch env.Type {
		case ipc.TypePing:
			if err := s.conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
				log.Warn("failed to send pong", "uid", s.UID, "error", err.Error())
				return
			}
		case ipc.TypeCapabilities:
			var caps ipc.Capabilities
			if err := json.Unmarshal(env.Payload, &caps); err != nil {
				log.Warn("invalid capabilities payload", "uid", s.UID, "error", err.Error())
			} else {
				s.SetCapabilities(sanitizeCapabilitiesForSession(s, &caps))
				log.Info("capabilities received",
					"uid", s.UID,
					"canNotify", s.Capabilities.CanNotify,
					"canTray", s.Capabilities.CanTray,
					"canCapture", s.Capabilities.CanCapture,
					"canClipboard", s.Capabilities.CanClipboard,
					"displayServer", s.Capabilities.DisplayServer,
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
	})

	// Clean up after disconnect
	b.removeSession(session)
	if session.HelperRole == backupipc.HelperRoleBackup {
		b.ClearBackupSession()
	}
	log.Info("user helper disconnected", "uid", session.UID, "sessionId", session.SessionID)
}

func (b *Broker) removeSession(session *Session) {
	b.mu.Lock()
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

// setupSocket is implemented in broker_windows.go and broker_unix.go.

func (b *Broker) verifyBinaryPath(peerPath string) bool {
	peerResolved, err := filepath.EvalSymlinks(peerPath)
	if err != nil {
		// Peer path might not be resolvable if the process has exited
		peerResolved = peerPath
	}
	peerResolved = filepath.Clean(peerResolved)
	for _, candidate := range b.allowedHelperPaths() {
		if filepath.Clean(candidate) == peerResolved {
			return true
		}
	}
	return false
}

func (b *Broker) allowedHelperPaths() []string {
	exePath, err := os.Executable()
	if err != nil {
		log.Warn("failed to get executable path, using hardcoded helper paths", "error", err.Error())
		return []string{
			"/usr/local/bin/breeze-agent",
			"/usr/local/bin/breeze-desktop-helper",
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
		"/usr/local/bin/breeze-agent",
		"/usr/local/bin/breeze-desktop-helper",
		"/usr/local/bin/breeze-watchdog",
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

func (b *Broker) computeAllowedHashes() map[string]struct{} {
	hashes := make(map[string]struct{})
	for _, path := range b.allowedHelperPaths() {
		sum, err := hashFileSHA256(path)
		if err != nil {
			log.Warn("failed to hash allowed helper binary", "path", path, "error", err.Error())
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
		if s.Capabilities != nil && s.Capabilities.CanCapture {
			continue
		}
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
