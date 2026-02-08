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
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	// HandshakeTimeout is the deadline for completing auth after connecting.
	HandshakeTimeout = 5 * time.Second

	// IdleTimeout disconnects helpers that send no messages for this duration.
	IdleTimeout = 30 * time.Minute

	// MaxConnectionsPerUID limits concurrent connections per user.
	MaxConnectionsPerUID = 3

	// RateLimitAttempts is max connection attempts per UID per window.
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

	mu       sync.RWMutex
	sessions map[string]*Session // sessionID -> Session
	byUID    map[uint32][]*Session
	closed   bool

	onMessage MessageHandler
	selfHash  string // SHA-256 of our own binary
}

// New creates a new session broker.
func New(socketPath string, onMessage MessageHandler) *Broker {
	b := &Broker{
		socketPath:  socketPath,
		rateLimiter: ipc.NewRateLimiter(RateLimitAttempts, RateLimitWindow),
		sessions:    make(map[string]*Session),
		byUID:       make(map[uint32][]*Session),
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

// SessionForUID returns the first active session for the given UID.
func (b *Broker) SessionForUID(uid uint32) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if sessions, ok := b.byUID[uid]; ok && len(sessions) > 0 {
		return sessions[0]
	}
	return nil
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

	// Step 2: Rate limit check
	if !b.rateLimiter.Allow(creds.UID) {
		log.Warn("connection rate limited", "uid", creds.UID, "pid", creds.PID)
		rawConn.Close()
		return
	}

	// Step 3: Check max connections per UID
	b.mu.RLock()
	uidCount := len(b.byUID[creds.UID])
	b.mu.RUnlock()
	if uidCount >= MaxConnectionsPerUID {
		log.Warn("max connections per UID exceeded", "uid", creds.UID, "count", uidCount)
		rawConn.Close()
		return
	}

	// Step 4: Verify binary path
	if !b.verifyBinaryPath(creds.BinaryPath) {
		log.Warn("binary path verification failed",
			"uid", creds.UID,
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
		log.Warn("auth request read failed", "uid", creds.UID, "error", err)
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

	// Verify UID matches peer credentials
	if authReq.UID != creds.UID {
		log.Warn("auth UID mismatch", "claimed", authReq.UID, "actual", creds.UID)
		conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
			Accepted: false,
			Reason:   "UID mismatch",
		})
		conn.Close()
		return
	}

	// Verify binary hash
	if authReq.BinaryHash != "" && b.selfHash != "" && authReq.BinaryHash != b.selfHash {
		log.Warn("binary hash mismatch",
			"uid", creds.UID,
			"expected", b.selfHash,
			"got", authReq.BinaryHash,
		)
		conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
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
	session := NewSession(conn, creds.UID, authReq.Username, authReq.DisplayEnv, authReq.SessionID, defaultScopes)

	// Register session
	b.mu.Lock()
	b.sessions[authReq.SessionID] = session
	b.byUID[creds.UID] = append(b.byUID[creds.UID], session)
	b.mu.Unlock()

	log.Info("user helper connected",
		"uid", creds.UID,
		"username", authReq.Username,
		"sessionId", authReq.SessionID,
		"display", authReq.DisplayEnv,
		"pid", creds.PID,
	)

	// Start receive loop — blocks until disconnect
	session.RecvLoop(func(s *Session, env *ipc.Envelope) {
		switch env.Type {
		case ipc.TypePing:
			s.conn.SendTyped(env.ID, ipc.TypePong, nil)
		case ipc.TypeCapabilities:
			var caps ipc.Capabilities
			if err := json.Unmarshal(env.Payload, &caps); err == nil {
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

	uid := session.UID
	sessions := b.byUID[uid]
	for i, s := range sessions {
		if s == session {
			b.byUID[uid] = append(sessions[:i], sessions[i+1:]...)
			break
		}
	}
	if len(b.byUID[uid]) == 0 {
		delete(b.byUID, uid)
	}
}

func (b *Broker) setupSocket() error {
	if runtime.GOOS == "windows" {
		return b.setupNamedPipe()
	}
	return b.setupUnixSocket()
}

func (b *Broker) setupUnixSocket() error {
	// Remove stale socket file
	os.Remove(b.socketPath)

	// Ensure directory exists
	dir := filepath.Dir(b.socketPath)
	if err := os.MkdirAll(dir, 0770); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	listener, err := net.Listen("unix", b.socketPath)
	if err != nil {
		return fmt.Errorf("listen %s: %w", b.socketPath, err)
	}

	// Set socket permissions: 0770 (owner + group can read/write)
	if err := os.Chmod(b.socketPath, 0770); err != nil {
		listener.Close()
		return fmt.Errorf("chmod %s: %w", b.socketPath, err)
	}

	b.listener = listener
	return nil
}

func (b *Broker) setupNamedPipe() error {
	// On Windows, use standard TCP listener on localhost as a fallback.
	// A production implementation would use the Windows named pipe API.
	// For now, this provides a working cross-platform implementation.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	b.listener = listener
	log.Info("windows IPC using TCP fallback", "addr", listener.Addr())
	return nil
}

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
