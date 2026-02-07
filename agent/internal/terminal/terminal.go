package terminal

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("terminal")

// Session represents an active terminal session
type Session struct {
	ID       string
	Cols     uint16
	Rows     uint16
	Shell    string
	pty      *os.File
	cmd      *exec.Cmd
	mu       sync.Mutex
	closed   bool
	onOutput func(data []byte)
	onClose  func(err error)
}

// Manager manages terminal sessions
type Manager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

// NewManager creates a new terminal session manager
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

// StartSession starts a new terminal session
func (m *Manager) StartSession(id string, cols, rows uint16, shell string, onOutput func(data []byte), onClose func(err error)) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if session already exists
	if _, exists := m.sessions[id]; exists {
		return fmt.Errorf("session %s already exists", id)
	}

	// Determine shell to use
	if shell == "" {
		shell = getDefaultShell()
	}

	session := &Session{
		ID:       id,
		Cols:     cols,
		Rows:     rows,
		Shell:    shell,
		onOutput: onOutput,
		onClose:  onClose,
	}

	// Start the PTY (platform-specific)
	if err := session.start(); err != nil {
		return fmt.Errorf("failed to start PTY: %w", err)
	}

	m.sessions[id] = session
	log.Info("session started", "sessionId", id, "shell", shell, "cols", cols, "rows", rows)

	return nil
}

// WriteToSession writes data to the terminal session's stdin
func (m *Manager) WriteToSession(id string, data []byte) error {
	m.mu.RLock()
	session, exists := m.sessions[id]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("session %s not found", id)
	}

	return session.write(data)
}

// ResizeSession resizes the terminal session
func (m *Manager) ResizeSession(id string, cols, rows uint16) error {
	m.mu.RLock()
	session, exists := m.sessions[id]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("session %s not found", id)
	}

	return session.resize(cols, rows)
}

// StopSession stops and removes a terminal session
func (m *Manager) StopSession(id string) error {
	m.mu.Lock()
	session, exists := m.sessions[id]
	if exists {
		delete(m.sessions, id)
	}
	m.mu.Unlock()

	if !exists {
		return fmt.Errorf("session %s not found", id)
	}

	return session.close()
}

// GetSession returns a session by ID
func (m *Manager) GetSession(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, exists := m.sessions[id]
	return session, exists
}

// GetSessionCount returns the number of active sessions
func (m *Manager) GetSessionCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

// CloseAll closes all terminal sessions
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		s.close()
	}
}

// write writes data to the session's PTY
func (s *Session) write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is closed")
	}

	if s.pty == nil {
		return fmt.Errorf("PTY not available")
	}

	_, err := s.pty.Write(data)
	return err
}

// close closes the terminal session
func (s *Session) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil
	}
	s.closed = true

	var closeErr error

	// Close PTY
	if s.pty != nil {
		if err := s.pty.Close(); err != nil {
			closeErr = err
		}
	}

	// Kill process if still running
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}

	log.Debug("session closed", "sessionId", s.ID)

	return closeErr
}

// readLoop reads output from the PTY and sends it to the callback
func (s *Session) readLoop() {
	buf := make([]byte, 4096)

	for {
		n, err := s.pty.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Warn("session read error", "sessionId", s.ID, "error", err)
			}
			if s.onClose != nil {
				s.onClose(err)
			}
			return
		}

		if n > 0 && s.onOutput != nil {
			// Make a copy of the data
			data := make([]byte, n)
			copy(data, buf[:n])
			s.onOutput(data)
		}
	}
}

// getDefaultShell returns the default shell for the current OS
func getDefaultShell() string {
	// Check SHELL environment variable first (Unix)
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}

	// Fallback defaults
	switch os := getOS(); os {
	case "windows":
		return "powershell.exe"
	case "darwin", "linux":
		return "/bin/bash"
	default:
		return "/bin/sh"
	}
}

// getOS returns the current operating system
func getOS() string {
	// This will be replaced by build tags in platform-specific files
	return "unix"
}
