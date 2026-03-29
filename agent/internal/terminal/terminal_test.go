package terminal

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// NewManager
// ---------------------------------------------------------------------------

func TestNewManager(t *testing.T) {
	m := NewManager()
	if m == nil {
		t.Fatal("NewManager returned nil")
	}
	if m.sessions == nil {
		t.Fatal("sessions map is nil")
	}
	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0 sessions, got %d", m.GetSessionCount())
	}
}

// ---------------------------------------------------------------------------
// GetSession
// ---------------------------------------------------------------------------

func TestGetSessionNotFound(t *testing.T) {
	m := NewManager()
	s, ok := m.GetSession("nonexistent")
	if ok {
		t.Fatal("expected ok=false for nonexistent session")
	}
	if s != nil {
		t.Fatal("expected nil session for nonexistent id")
	}
}

func TestGetSessionFound(t *testing.T) {
	m := NewManager()
	// Insert a session directly into the map to avoid platform-specific PTY start.
	m.mu.Lock()
	m.sessions["test-1"] = &Session{ID: "test-1", Shell: "/bin/sh"}
	m.mu.Unlock()

	s, ok := m.GetSession("test-1")
	if !ok {
		t.Fatal("expected ok=true for inserted session")
	}
	if s == nil {
		t.Fatal("expected non-nil session")
	}
	if s.ID != "test-1" {
		t.Fatalf("expected session id test-1, got %s", s.ID)
	}
}

// ---------------------------------------------------------------------------
// GetSessionCount
// ---------------------------------------------------------------------------

func TestGetSessionCount(t *testing.T) {
	m := NewManager()

	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0, got %d", m.GetSessionCount())
	}

	m.mu.Lock()
	m.sessions["a"] = &Session{ID: "a"}
	m.sessions["b"] = &Session{ID: "b"}
	m.mu.Unlock()

	if m.GetSessionCount() != 2 {
		t.Fatalf("expected 2, got %d", m.GetSessionCount())
	}
}

// ---------------------------------------------------------------------------
// StartSession – duplicate detection
// ---------------------------------------------------------------------------

func TestStartSessionDuplicateID(t *testing.T) {
	m := NewManager()

	// Inject a session manually to avoid starting a real PTY.
	m.mu.Lock()
	m.sessions["dup"] = &Session{ID: "dup"}
	m.mu.Unlock()

	err := m.StartSession("dup", 80, 24, "/bin/sh", nil, nil)
	if err == nil {
		t.Fatal("expected error for duplicate session id")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// StartSession – real PTY (integration, Unix/macOS only)
// ---------------------------------------------------------------------------

func TestStartSessionRealPTY(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("real PTY test requires Unix/macOS")
	}

	m := NewManager()

	err := m.StartSession("real-1", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if m.GetSessionCount() != 1 {
		t.Fatalf("expected 1 session, got %d", m.GetSessionCount())
	}

	s, ok := m.GetSession("real-1")
	if !ok || s == nil {
		t.Fatal("session not found after StartSession")
	}
	if s.Shell != "/bin/sh" {
		t.Fatalf("expected shell /bin/sh, got %s", s.Shell)
	}

	// Write a command to the PTY.
	if err := m.WriteToSession("real-1", []byte("echo HELLO_BREEZE\n")); err != nil {
		t.Fatalf("WriteToSession: %v", err)
	}

	// Stop the session.
	if err := m.StopSession("real-1"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}
	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0 sessions after stop, got %d", m.GetSessionCount())
	}
}

// ---------------------------------------------------------------------------
// WriteToSession – errors
// ---------------------------------------------------------------------------

func TestWriteToSessionNotFound(t *testing.T) {
	m := NewManager()
	err := m.WriteToSession("missing", []byte("data"))
	if err == nil {
		t.Fatal("expected error for missing session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// ResizeSession
// ---------------------------------------------------------------------------

func TestResizeSessionNotFound(t *testing.T) {
	m := NewManager()
	err := m.ResizeSession("missing", 120, 40)
	if err == nil {
		t.Fatal("expected error for missing session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResizeSessionRealPTY(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("real PTY resize test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("resize-1", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	defer m.StopSession("resize-1")

	// Resize should succeed.
	if err := m.ResizeSession("resize-1", 120, 40); err != nil {
		t.Fatalf("ResizeSession: %v", err)
	}

	s, _ := m.GetSession("resize-1")
	if s.Cols != 120 || s.Rows != 40 {
		t.Fatalf("expected 120x40, got %dx%d", s.Cols, s.Rows)
	}
}

// ---------------------------------------------------------------------------
// StopSession
// ---------------------------------------------------------------------------

func TestStopSessionNotFound(t *testing.T) {
	m := NewManager()
	err := m.StopSession("missing")
	if err == nil {
		t.Fatal("expected error for missing session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStopSessionRemovesFromMap(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("stop-1", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if m.GetSessionCount() != 1 {
		t.Fatal("expected 1 session")
	}

	if err := m.StopSession("stop-1"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	if m.GetSessionCount() != 0 {
		t.Fatal("expected 0 sessions after stop")
	}

	_, ok := m.GetSession("stop-1")
	if ok {
		t.Fatal("session should not be found after stop")
	}
}

// ---------------------------------------------------------------------------
// CloseAll
// ---------------------------------------------------------------------------

func TestCloseAll(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("closeall-%d", i)
		err := m.StartSession(id, 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
		if err != nil {
			t.Fatalf("StartSession(%s): %v", id, err)
		}
	}

	if m.GetSessionCount() != 3 {
		t.Fatalf("expected 3 sessions, got %d", m.GetSessionCount())
	}

	m.CloseAll()

	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0 sessions after CloseAll, got %d", m.GetSessionCount())
	}
}

func TestCloseAllEmpty(t *testing.T) {
	m := NewManager()
	// Should not panic on empty manager.
	m.CloseAll()
	if m.GetSessionCount() != 0 {
		t.Fatal("expected 0 sessions")
	}
}

// ---------------------------------------------------------------------------
// getDefaultShell
// ---------------------------------------------------------------------------

func TestGetDefaultShell(t *testing.T) {
	// Save and restore SHELL env var.
	origShell := os.Getenv("SHELL")
	defer os.Setenv("SHELL", origShell)

	// Test with SHELL set.
	os.Setenv("SHELL", "/usr/bin/fish")
	if got := getDefaultShell(); got != "/usr/bin/fish" {
		t.Fatalf("expected /usr/bin/fish, got %s", got)
	}

	// Test with SHELL unset — should use platform defaults.
	os.Unsetenv("SHELL")
	got := getDefaultShell()

	switch runtime.GOOS {
	case "windows":
		if got != "powershell.exe" {
			t.Fatalf("expected powershell.exe on windows, got %s", got)
		}
	case "darwin":
		if got != "/bin/zsh" {
			t.Fatalf("expected /bin/zsh on darwin, got %s", got)
		}
	case "linux":
		if got != "/bin/bash" {
			t.Fatalf("expected /bin/bash on linux, got %s", got)
		}
	default:
		if got != "/bin/sh" {
			t.Fatalf("expected /bin/sh on %s, got %s", runtime.GOOS, got)
		}
	}
}

func TestGetDefaultShellRespectsEnvVar(t *testing.T) {
	origShell := os.Getenv("SHELL")
	defer os.Setenv("SHELL", origShell)

	tests := []struct {
		name     string
		envValue string
		want     string
	}{
		{"bash", "/bin/bash", "/bin/bash"},
		{"zsh", "/bin/zsh", "/bin/zsh"},
		{"fish", "/usr/local/bin/fish", "/usr/local/bin/fish"},
		{"custom", "/opt/shells/myshell", "/opt/shells/myshell"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			os.Setenv("SHELL", tt.envValue)
			if got := getDefaultShell(); got != tt.want {
				t.Fatalf("expected %s, got %s", tt.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// StartSession – default shell selection
// ---------------------------------------------------------------------------

func TestStartSessionUsesDefaultShellWhenEmpty(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("default-shell", 80, 24, "", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	defer m.StopSession("default-shell")

	s, ok := m.GetSession("default-shell")
	if !ok {
		t.Fatal("session not found")
	}

	// The shell should have been resolved to a non-empty default.
	if s.Shell == "" {
		t.Fatal("expected shell to be set to a default value")
	}
}

// ---------------------------------------------------------------------------
// Session struct field visibility
// ---------------------------------------------------------------------------

func TestSessionFields(t *testing.T) {
	s := &Session{
		ID:    "field-test",
		Cols:  132,
		Rows:  43,
		Shell: "/bin/bash",
	}

	if s.ID != "field-test" {
		t.Fatalf("expected ID field-test, got %s", s.ID)
	}
	if s.Cols != 132 {
		t.Fatalf("expected Cols 132, got %d", s.Cols)
	}
	if s.Rows != 43 {
		t.Fatalf("expected Rows 43, got %d", s.Rows)
	}
	if s.Shell != "/bin/bash" {
		t.Fatalf("expected Shell /bin/bash, got %s", s.Shell)
	}
}
