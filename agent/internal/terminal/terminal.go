package terminal

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
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
	pty      *os.File       // used on Unix/macOS for real PTY master fd; on Windows ConPTY for output pipe
	stdin    io.WriteCloser // used on Windows for pipe-based stdin (both ConPTY and legacy pipes)
	cmd      *exec.Cmd      // process command (Unix/macOS; nil on Windows ConPTY)
	mu       sync.Mutex
	closed   bool
	waitOnce sync.Once // ensures process wait is called exactly once
	endOnce  sync.Once // ensures terminal close callback runs once
	onOutput func(data []byte)
	onClose  func(err error)

	// Windows ConPTY handles (zero on Unix/macOS).
	hConPty uintptr // HPCON pseudo console handle
	hProc   uintptr // child process handle
	hThread uintptr // child primary thread handle
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
	}
	session.onClose = func(err error) {
		m.removeSessionIfCurrent(id, session)
		if onClose != nil {
			onClose(err)
		}
	}

	m.sessions[id] = session

	// Start the PTY (platform-specific)
	if err := session.start(); err != nil {
		delete(m.sessions, id)
		return fmt.Errorf("failed to start PTY: %w", err)
	}
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

func (m *Manager) removeSessionIfCurrent(id string, target *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current, exists := m.sessions[id]
	if !exists || current != target {
		return
	}
	delete(m.sessions, id)
}

// write writes data to the session's PTY or stdin pipe
func (s *Session) write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is closed")
	}

	// Forward control characters as signals to the shell process.
	// This runs on all platforms before writing data to the pipe/PTY.
	for _, b := range data {
		s.forwardSignal(b)
	}

	// Prefer stdin pipe (Windows), fall back to PTY fd (Unix/macOS)
	if s.stdin != nil {
		_, err := s.stdin.Write(data)
		return err
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

	// Close stdin pipe (Windows)
	if s.stdin != nil {
		if err := s.stdin.Close(); err != nil {
			closeErr = err
		}
	}

	// Close PTY (Unix/macOS)
	if s.pty != nil {
		if err := s.pty.Close(); err != nil {
			closeErr = err
		}
	}

	// Kill and wait for process — platform-specific
	s.killProcess()
	s.waitCmd()

	log.Debug("session closed", "sessionId", s.ID)

	return closeErr
}

// waitCmd calls cmd.Wait() exactly once, regardless of how many goroutines
// call it. This prevents the data race between the background Wait goroutine
// spawned by start() and the close() method.
func (s *Session) waitCmd() error {
	var err error
	s.waitOnce.Do(func() {
		err = s.awaitProcess()
	})
	return err
}

func (s *Session) notifyClosed(err error) {
	s.endOnce.Do(func() {
		if s.onClose != nil {
			s.onClose(err)
		}
	})
}

// readLoop reads output from the PTY and sends it to the callback
func (s *Session) readLoop() {
	log.Info("readLoop started", "sessionId", s.ID)
	buf := make([]byte, 4096)
	firstRead := true

	for {
		n, err := s.pty.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Warn("session read error", "sessionId", s.ID, "error", err)
			} else {
				log.Info("readLoop EOF", "sessionId", s.ID)
			}
			s.notifyClosed(err)
			return
		}

		if n > 0 && s.onOutput != nil {
			if firstRead {
				log.Info("readLoop first data", "sessionId", s.ID, "bytes", n)
				firstRead = false
			}
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

	// Fallback defaults based on runtime OS
	switch runtime.GOOS {
	case "windows":
		return "powershell.exe"
	case "darwin":
		return "/bin/zsh"
	case "linux":
		return "/bin/bash"
	default:
		return "/bin/sh"
	}
}
