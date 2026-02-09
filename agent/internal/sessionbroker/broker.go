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

// defaultScopes are the allowed scopes for user helpers.
var defaultScopes = []string{"notify", "tray", "clipboard", "desktop", "run_as_user"}

// MessageHandler is called when a user helper sends a message that isn't
// a response to a pending command.
type MessageHandler func(session *Session, env *ipc.Envelope)

// Broker manages IPC connections from user helper processes.
type Broker struct {
	socketPath  string
	listener    net.Listener
	rateLimiter *ipc.RateLimiter

	mu         sync.RWMutex
	sessions   map[string]*Session   // sessionID -> Session
	byIdentity map[string][]*Session // identity key -> Sessions (UID string on Unix, SID on Windows)
	closed     bool

	onMessage MessageHandler
	selfHash  string // SHA-256 of our own binary
}

// New creates a new session broker.
func New(socketPath string, onMessage MessageHandler) *Broker {
	b := &Broker{
		socketPath:  socketPath,
		rateLimiter: ipc.NewRateLimiter(RateLimitAttempts, RateLimitWindow),
		sessions:    make(map[string]*Session),
		byIdentity:  make(map[string][]*Session),
		onMessage:   onMessage,
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
				log.Warn("accept error", "error", err)
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
		log.Warn("peer credential check failed", "error", err)
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
		log.Warn("auth request read failed", "identity", identityKey, "error", err)
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
		log.Warn("invalid auth request payload", "error", err)
		conn.Close()
		return
	}

	// Step 6: Verify identity — SID on Windows, UID on Unix
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

	// Step 7: Verify binary hash (require non-empty hash from client)
	if b.selfHash != "" && authReq.BinaryHash != b.selfHash {
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

	// Generate session key
	sessionKey, err := ipc.GenerateSessionKey()
	if err != nil {
		log.Error("failed to generate session key", "error", err)
		conn.Close()
		return
	}

	// Send auth response
	authResp := ipc.AuthResponse{
		Accepted:      true,
		SessionKey:    hex.EncodeToString(sessionKey),
		AllowedScopes: defaultScopes,
	}
	if err := conn.SendTyped(env.ID, ipc.TypeAuthResponse, authResp); err != nil {
		log.Warn("failed to send auth response", "error", err)
		conn.Close()
		return
	}

	// Set session key for HMAC validation
	conn.SetSessionKey(sessionKey)

	// Clear the handshake deadline
	rawConn.SetDeadline(time.Time{})

	// Create session
	session := NewSession(conn, creds.UID, identityKey, authReq.Username, authReq.DisplayEnv, authReq.SessionID, defaultScopes)

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
	)

	// Start receive loop — blocks until disconnect
	session.RecvLoop(func(s *Session, env *ipc.Envelope) {
		switch env.Type {
		case ipc.TypePing:
			if err := s.conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
				log.Warn("failed to send pong", "uid", s.UID, "error", err)
				return
			}
		case ipc.TypeCapabilities:
			var caps ipc.Capabilities
			if err := json.Unmarshal(env.Payload, &caps); err != nil {
				log.Warn("invalid capabilities payload", "uid", s.UID, "error", err)
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
		default:
			if b.onMessage != nil {
				b.onMessage(s, env)
			}
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
}

// setupSocket is implemented in broker_windows.go and broker_unix.go.

func (b *Broker) verifyBinaryPath(peerPath string) bool {
	expected, err := os.Executable()
	if err != nil {
		log.Warn("failed to get own executable path", "error", err)
		return false
	}
	expected, err = filepath.EvalSymlinks(expected)
	if err != nil {
		log.Warn("failed to resolve symlinks for own path", "error", err)
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
		log.Warn("failed to get executable path for hash", "error", err)
		return ""
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(exePath)
	if err != nil {
		log.Warn("failed to read executable for hash", "error", err)
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
