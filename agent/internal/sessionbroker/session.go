package sessionbroker

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("sessionbroker")

type pendingResponse struct {
	ch           chan *ipc.Envelope
	expectedType string
	validate     func(*ipc.Envelope) error
}

// Session represents a connected user helper with verified identity.
type Session struct {
	UID            uint32 // Numeric UID (0 on Windows; kept for logging/compat)
	IdentityKey    string // Platform identity: UID string on Unix, SID on Windows
	Username       string
	DisplayEnv     string
	SessionID      string
	PID            int // OS process ID of the helper process
	Capabilities   *ipc.Capabilities
	TCCStatus      *ipc.TCCStatus
	AllowedScopes  []string
	WinSessionID   string // Windows session ID string (e.g., "1", "2") for targeting
	HelperRole     string // "system" or "user" — determines scopes and capabilities
	BinaryKind     string
	DesktopContext string
	ConnectedAt    time.Time
	LastSeen       time.Time

	conn    *ipc.Conn
	mu      sync.Mutex
	done    chan struct{}
	closed  bool
	pending map[string]pendingResponse // command ID -> response channel + expected response type
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
		done:          make(chan struct{}),
		pending:       make(map[string]pendingResponse),
	}
}

// SendCommand sends a command to the user helper and waits for a response.
// Returns the response envelope or an error if the timeout is reached.
func (s *Session) SendCommand(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
	ch := make(chan *ipc.Envelope, 1)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("session closed")
	}
	s.pending[id] = pendingResponse{
		ch:           ch,
		expectedType: expectedResponseType(cmdType),
		validate:     responseValidator(cmdType, payload),
	}
	done := s.done
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
	case <-done:
		return nil, fmt.Errorf("session closed while waiting for response")
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
	pending, ok := s.pending[env.ID]
	s.mu.Unlock()

	if ok {
		if pending.expectedType != "" && env.Type != pending.expectedType {
			log.Warn("response type mismatch, dropping",
				"id", env.ID,
				"expectedType", pending.expectedType,
				"actualType", env.Type,
				"sessionId", s.SessionID,
			)
			return true
		}
		if pending.validate != nil && env.Error == "" {
			if err := pending.validate(env); err != nil {
				log.Warn("response payload validation failed, dropping",
					"id", env.ID,
					"type", env.Type,
					"sessionId", s.SessionID,
					"error", err.Error(),
				)
				return true
			}
		}
		select {
		case pending.ch <- env:
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

// GetCapabilities returns a copy of the session's reported capabilities, or
// nil if none have been received yet. Safe to call from any goroutine; takes
// s.mu to serialise with SetCapabilities.
//
// Snapshot-path readers (FindCapableSession, preferredDesktopSessionFromSnap,
// etc.) must use this accessor instead of reading s.Capabilities directly.
// Before the atomic-snapshot refactor, b.mu.RLock() accidentally serialised
// those reads with SetCapabilities writers; without it, direct reads race
// under -race.
func (s *Session) GetCapabilities() *ipc.Capabilities {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Capabilities == nil {
		return nil
	}
	cp := *s.Capabilities
	return &cp
}

// SetTCCStatus updates the session's macOS TCC permission status.
func (s *Session) SetTCCStatus(status *ipc.TCCStatus) {
	s.mu.Lock()
	s.TCCStatus = status
	s.mu.Unlock()
}

// GetTCCStatus returns the session's last-reported TCC permission status.
func (s *Session) GetTCCStatus() *ipc.TCCStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.TCCStatus
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
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	for id := range s.pending {
		delete(s.pending, id)
	}
	done := s.done
	s.mu.Unlock()

	if done != nil {
		close(done)
	}

	return s.conn.Close()
}

// SessionInfo is a serializable summary of a session for status reporting.
type SessionInfo struct {
	UID            uint32            `json:"uid"`
	IdentityKey    string            `json:"identityKey"`
	Username       string            `json:"username"`
	DisplayEnv     string            `json:"displayEnv"`
	SessionID      string            `json:"sessionId"`
	Capabilities   *ipc.Capabilities `json:"capabilities,omitempty"`
	ConnectedAt    time.Time         `json:"connectedAt"`
	LastSeen       time.Time         `json:"lastSeen"`
	WinSessionID   string            `json:"winSessionId,omitempty"`
	HelperRole     string            `json:"helperRole,omitempty"`
	BinaryKind     string            `json:"binaryKind,omitempty"`
	DesktopContext string            `json:"desktopContext,omitempty"`
}

// Info returns a serializable summary of this session.
func (s *Session) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{
		UID:            s.UID,
		IdentityKey:    s.IdentityKey,
		Username:       s.Username,
		DisplayEnv:     s.DisplayEnv,
		SessionID:      s.SessionID,
		Capabilities:   s.Capabilities,
		ConnectedAt:    s.ConnectedAt,
		LastSeen:       s.LastSeen,
		WinSessionID:   s.WinSessionID,
		HelperRole:     s.HelperRole,
		BinaryKind:     s.BinaryKind,
		DesktopContext: s.DesktopContext,
	}
}

// RecvLoop reads messages from the connection and dispatches them.
// It calls onMessage for each received envelope.
// Returns when the connection is closed or an error occurs.
func (s *Session) RecvLoop(onMessage func(*Session, *ipc.Envelope)) {
	for {
		env, err := s.conn.Recv()
		if err != nil {
			log.Info("session recv loop ended", "uid", s.UID, "sessionId", s.SessionID, "error", err.Error())
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

func expectedResponseType(cmdType string) string {
	switch cmdType {
	case ipc.TypeCommand:
		return ipc.TypeCommandResult
	case ipc.TypeNotify:
		return ipc.TypeNotifyResult
	case ipc.TypeClipboardGet:
		return ipc.TypeClipboardData
	case ipc.TypeClipboardSet:
		return ipc.TypeClipboardSet
	case ipc.TypeDesktopStart:
		return ipc.TypeDesktopStart
	case ipc.TypeDesktopStop:
		return ipc.TypeDesktopStop
	case ipc.TypeSASRequest:
		return ipc.TypeSASResponse
	case ipc.TypeLaunchProcess:
		return ipc.TypeLaunchResult
	case backupipc.TypeBackupCommand:
		return backupipc.TypeBackupResult
	default:
		return ""
	}
}

func responseValidator(cmdType string, payload any) func(*ipc.Envelope) error {
	switch cmdType {
	case ipc.TypeCommand:
		req, ok := payload.(ipc.IPCCommand)
		if !ok || req.CommandID == "" {
			return nil
		}
		return func(env *ipc.Envelope) error {
			var result ipc.IPCCommandResult
			if err := json.Unmarshal(env.Payload, &result); err != nil {
				return fmt.Errorf("unmarshal command result: %w", err)
			}
			if result.CommandID != req.CommandID {
				return fmt.Errorf("commandId mismatch: expected %q got %q", req.CommandID, result.CommandID)
			}
			return nil
		}
	case ipc.TypeDesktopStart:
		req, ok := payload.(ipc.DesktopStartRequest)
		if !ok || req.SessionID == "" {
			return nil
		}
		return func(env *ipc.Envelope) error {
			var result ipc.DesktopStartResponse
			if err := json.Unmarshal(env.Payload, &result); err != nil {
				return fmt.Errorf("unmarshal desktop start response: %w", err)
			}
			if result.SessionID != req.SessionID {
				return fmt.Errorf("sessionId mismatch: expected %q got %q", req.SessionID, result.SessionID)
			}
			return nil
		}
	case backupipc.TypeBackupCommand:
		req, ok := payload.(backupipc.BackupCommandRequest)
		if !ok || req.CommandID == "" {
			return nil
		}
		return func(env *ipc.Envelope) error {
			var result backupipc.BackupCommandResult
			if err := json.Unmarshal(env.Payload, &result); err != nil {
				return fmt.Errorf("unmarshal backup command result: %w", err)
			}
			if result.CommandID != req.CommandID {
				return fmt.Errorf("backup commandId mismatch: expected %q got %q", req.CommandID, result.CommandID)
			}
			return nil
		}
	default:
		return nil
	}
}
