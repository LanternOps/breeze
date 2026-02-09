package sessionbroker

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("sessionbroker")

// Session represents a connected user helper with verified identity.
type Session struct {
	UID           uint32 // Numeric UID (0 on Windows; kept for logging/compat)
	IdentityKey   string // Platform identity: UID string on Unix, SID on Windows
	Username      string
	DisplayEnv    string
	SessionID     string
	Capabilities  *ipc.Capabilities
	AllowedScopes []string
	ConnectedAt   time.Time
	LastSeen      time.Time

	conn    *ipc.Conn
	mu      sync.Mutex
	pending map[string]chan *ipc.Envelope // command ID -> response channel
}

// NewSession creates a new session for a verified user helper connection.
func NewSession(conn *ipc.Conn, uid uint32, identityKey, username, displayEnv, sessionID string, scopes []string) *Session {
	return &Session{
		UID:           uid,
		IdentityKey:   identityKey,
		Username:      username,
		DisplayEnv:    displayEnv,
		SessionID:     sessionID,
		AllowedScopes: scopes,
		ConnectedAt:   time.Now(),
		LastSeen:      time.Now(),
		conn:          conn,
		pending:       make(map[string]chan *ipc.Envelope),
	}
}

// SendCommand sends a command to the user helper and waits for a response.
// Returns the response envelope or an error if the timeout is reached.
func (s *Session) SendCommand(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
	ch := make(chan *ipc.Envelope, 1)
	s.mu.Lock()
	s.pending[id] = ch
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	if err := s.conn.SendTyped(id, cmdType, payload); err != nil {
		return nil, err
	}

	select {
	case resp, ok := <-ch:
		if !ok || resp == nil {
			return nil, fmt.Errorf("session closed while waiting for response")
		}
		return resp, nil
	case <-time.After(timeout):
		return nil, ErrCommandTimeout
	}
}

// SendNotify sends a fire-and-forget message (no response expected).
func (s *Session) SendNotify(id, msgType string, payload any) error {
	return s.conn.SendTyped(id, msgType, payload)
}

// HandleResponse routes a received envelope to the pending command channel.
// Returns true if the message was matched to a pending command.
func (s *Session) HandleResponse(env *ipc.Envelope) bool {
	s.mu.Lock()
	ch, ok := s.pending[env.ID]
	s.mu.Unlock()

	if ok {
		select {
		case ch <- env:
		default:
			log.Warn("response channel full, dropping", "id", env.ID)
		}
		return true
	}
	return false
}

// Touch updates the last-seen timestamp.
func (s *Session) Touch() {
	s.mu.Lock()
	s.LastSeen = time.Now()
	s.mu.Unlock()
}

// IdleDuration returns how long this session has been idle.
func (s *Session) IdleDuration() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.LastSeen)
}

// SetCapabilities updates the session's reported capabilities.
func (s *Session) SetCapabilities(caps *ipc.Capabilities) {
	s.mu.Lock()
	s.Capabilities = caps
	s.mu.Unlock()
}

// HasScope checks if this session is authorized for the given scope.
func (s *Session) HasScope(scope string) bool {
	for _, allowed := range s.AllowedScopes {
		if allowed == scope || allowed == "*" {
			return true
		}
	}
	return false
}

// Close closes the underlying connection and cancels all pending commands.
func (s *Session) Close() error {
	s.mu.Lock()
	for id, ch := range s.pending {
		close(ch)
		delete(s.pending, id)
	}
	s.mu.Unlock()
	return s.conn.Close()
}

// SessionInfo is a serializable summary of a session for status reporting.
type SessionInfo struct {
	UID          uint32             `json:"uid"`
	IdentityKey  string             `json:"identityKey"`
	Username     string             `json:"username"`
	DisplayEnv   string             `json:"displayEnv"`
	SessionID    string             `json:"sessionId"`
	Capabilities *ipc.Capabilities  `json:"capabilities,omitempty"`
	ConnectedAt  time.Time          `json:"connectedAt"`
	LastSeen     time.Time          `json:"lastSeen"`
}

// Info returns a serializable summary of this session.
func (s *Session) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{
		UID:          s.UID,
		IdentityKey:  s.IdentityKey,
		Username:     s.Username,
		DisplayEnv:   s.DisplayEnv,
		SessionID:    s.SessionID,
		Capabilities: s.Capabilities,
		ConnectedAt:  s.ConnectedAt,
		LastSeen:     s.LastSeen,
	}
}

// RecvLoop reads messages from the connection and dispatches them.
// It calls onMessage for each received envelope.
// Returns when the connection is closed or an error occurs.
func (s *Session) RecvLoop(onMessage func(*Session, *ipc.Envelope)) {
	for {
		env, err := s.conn.Recv()
		if err != nil {
			log.Debug("session recv loop ended", "uid", s.UID, "error", err)
			return
		}
		s.Touch()

		// Try to match to a pending command response first
		if s.HandleResponse(env) {
			continue
		}

		// Otherwise dispatch to the broker's message handler
		onMessage(s, env)
	}
}

// UnmarshalPayload is a helper to decode an envelope's payload into a typed struct.
func UnmarshalPayload[T any](env *ipc.Envelope) (T, error) {
	var result T
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		return result, err
	}
	return result, nil
}
