package sessionbroker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

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
	systemHelperScopes = []string{"notify", "tray", "clipboard", "desktop"}
	userHelperScopes   = []string{"notify", "clipboard", "run_as_user"}
)

// MessageHandler is called when a user helper sends a message that isn't
// a response to a pending command.
type MessageHandler func(session *Session, env *ipc.Envelope)

// Broker manages IPC connections from user helper processes.
type Broker struct {
	socketPath  string
	listener    net.Listener
	rateLimiter *ipc.RateLimiter

	mu           sync.RWMutex
	sessions     map[string]*Session   // sessionID -> Session
	byIdentity   map[string][]*Session // identity key -> Sessions (UID string on Unix, SID on Windows)
	staleHelpers map[string][]int      // winSessionID -> PIDs of disconnected helpers
	closed       bool

	onMessage MessageHandler
	selfHash  string // SHA-256 of our own binary
}

// New creates a new session broker.
func New(socketPath string, onMessage MessageHandler) *Broker {
	b := &Broker{
		socketPath:  socketPath,
		rateLimiter:  ipc.NewRateLimiter(RateLimitAttempts, RateLimitWindow),
		sessions:     make(map[string]*Session),
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
		onMessage:    onMessage,
	}
	b.selfHash = b.computeSelfHash()
	return b
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
	for _, s := range b.sessions {
		if s.Username == username {
			return s
		}
	}
	return nil
}

// SessionForIdentity returns the first active session for the given identity key.
// The key is a UID string on Unix or a SID on Windows.
func (b *Broker) SessionForIdentity(key string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if sessions, ok := b.byIdentity[key]; ok && len(sessions) > 0 {
		return sessions[0]
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

// FindCapableSession returns the first connected session whose helper reports
// the given capability (e.g., "capture"). If targetWinSession is non-empty,
// only sessions in that Windows session are considered.
func (b *Broker) FindCapableSession(capability string, targetWinSession string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, s := range b.sessions {
		if targetWinSession != "" && targetWinSession != "0" && s.WinSessionID != targetWinSession {
			continue
		}
		if s.Capabilities == nil {
			continue
		}
		switch capability {
		case "capture":
			if s.Capabilities.CanCapture {
				return s
			}
		case "clipboard":
			if s.Capabilities.CanClipboard {
				return s
			}
		case "notify":
			if s.Capabilities.CanNotify {
				return s
			}
		}
	}
	return nil
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
	for _, s := range b.sessions {
		if s.WinSessionID == winSessionID && s.HelperRole == ipc.HelperRoleUser {
			return s
		}
	}
	return nil
}


// LaunchProcessViaUserHelper asks a connected user-role helper to launch a
// binary. The helper is already running as the logged-in user, so the
// launched process inherits the user's identity and environment.
func (b *Broker) LaunchProcessViaUserHelper(binaryPath string) error {
	b.mu.RLock()
	var userSession *Session
	for _, s := range b.sessions {
		if s.HelperRole == ipc.HelperRoleUser {
			userSession = s
			break
		}
	}
	b.mu.RUnlock()

	if userSession == nil {
		return fmt.Errorf("no user-role helper connected")
	}

	id := fmt.Sprintf("launch-%d", time.Now().UnixMilli())
	resp, err := userSession.SendCommand(id, ipc.TypeLaunchProcess,
		ipc.LaunchProcessRequest{BinaryPath: binaryPath}, 15*time.Second)
	if err != nil {
		return fmt.Errorf("launch_process IPC failed: %w", err)
	}

	var result ipc.LaunchProcessResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return fmt.Errorf("unmarshal launch result: %w", err)
	}
	if !result.OK {
		return fmt.Errorf("user helper launch failed: %s", result.Error)
	}

	log.Info("process launched via user helper", "binary", binaryPath, "pid", result.PID)
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

	// Step 8: Verify binary hash — reject ALL helpers if our own hash is unavailable
	if b.selfHash == "" {
		log.Error("rejecting helper connection: agent binary hash unavailable — cannot verify helper integrity",
			"identity", identityKey,
			"pid", creds.PID,
		)
		_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   "agent binary hash unavailable",
		})
		conn.Close()
		return
	}
	if authReq.BinaryHash != b.selfHash {
		log.Warn("binary hash mismatch",
			"identity", identityKey,
			"expected", b.selfHash,
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
	if runtime.GOOS == "windows" {
		const systemSID = "S-1-5-18"
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
	}

	var scopes []string
	switch helperRole {
	case ipc.HelperRoleUser:
		scopes = userHelperScopes
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
	b.mu.Unlock()

	log.Info("user helper connected",
		"identity", identityKey,
		"username", authReq.Username,
		"sessionId", authReq.SessionID,
		"display", authReq.DisplayEnv,
		"pid", creds.PID,
		"role", helperRole,
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
				s.SetCapabilities(&caps)
				log.Info("capabilities received",
					"uid", s.UID,
					"canNotify", caps.CanNotify,
					"canTray", caps.CanTray,
					"canCapture", caps.CanCapture,
					"canClipboard", caps.CanClipboard,
					"displayServer", caps.DisplayServer,
				)
			}
		case ipc.TypeDisconnect:
			log.Info("user helper disconnecting", "uid", s.UID, "sessionId", s.SessionID)
			s.Close()
		case ipc.TypeTrayAction, ipc.TypeNotifyResult, ipc.TypeClipboardData, ipc.TypeCommandResult, ipc.TypeSASRequest, ipc.TypeDesktopPeerDisconnected:
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
	log.Info("user helper disconnected", "uid", session.UID, "sessionId", session.SessionID)
}

func (b *Broker) removeSession(session *Session) {
	b.mu.Lock()
	defer b.mu.Unlock()

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
	expected, err := os.Executable()
	if err != nil {
		log.Warn("failed to get own executable path", "error", err.Error())
		return false
	}
	expected, err = filepath.EvalSymlinks(expected)
	if err != nil {
		log.Warn("failed to resolve symlinks for own path", "error", err.Error())
		return false
	}
	peerResolved, err := filepath.EvalSymlinks(peerPath)
	if err != nil {
		// Peer path might not be resolvable if the process has exited
		peerResolved = peerPath
	}
	return filepath.Clean(expected) == filepath.Clean(peerResolved)
}

func (b *Broker) computeSelfHash() string {
	exePath, err := os.Executable()
	if err != nil {
		log.Warn("failed to get executable path for hash", "error", err.Error())
		return ""
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(exePath)
	if err != nil {
		log.Warn("failed to read executable for hash", "error", err.Error())
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
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
