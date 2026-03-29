//go:build !windows

package terminal

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Session.start — PTY creation and process launch
// ---------------------------------------------------------------------------

func TestSessionStartCreatesFields(t *testing.T) {
	s := &Session{
		ID:       "start-fields",
		Cols:     80,
		Rows:     24,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	if s.pty == nil {
		t.Fatal("expected pty to be set after start")
	}
	if s.cmd == nil {
		t.Fatal("expected cmd to be set after start")
	}
	if s.cmd.Process == nil {
		t.Fatal("expected cmd.Process to be set after start")
	}
	if s.cmd.Process.Pid <= 0 {
		t.Fatalf("expected positive PID, got %d", s.cmd.Process.Pid)
	}
}

func TestSessionStartInvalidShell(t *testing.T) {
	s := &Session{
		ID:       "start-invalid-shell",
		Cols:     80,
		Rows:     24,
		Shell:    "/nonexistent/shell/binary",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	err := s.start()
	if err == nil {
		s.close()
		t.Fatal("expected error for nonexistent shell")
	}
	if !strings.Contains(err.Error(), "failed to start shell") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSessionStartSetsTermEnv(t *testing.T) {
	s := &Session{
		ID:       "start-env",
		Cols:     100,
		Rows:     50,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	// Verify the command was configured with TERM env.
	foundTerm := false
	foundCols := false
	foundLines := false
	for _, env := range s.cmd.Env {
		if env == "TERM=xterm-256color" {
			foundTerm = true
		}
		if env == "COLUMNS=100" {
			foundCols = true
		}
		if env == "LINES=50" {
			foundLines = true
		}
	}
	if !foundTerm {
		t.Fatal("expected TERM=xterm-256color in env")
	}
	if !foundCols {
		t.Fatal("expected COLUMNS=100 in env")
	}
	if !foundLines {
		t.Fatal("expected LINES=50 in env")
	}
}

// ---------------------------------------------------------------------------
// Session.resize — PTY window size changes
// ---------------------------------------------------------------------------

func TestSessionResizeUpdatesFields(t *testing.T) {
	s := &Session{
		ID:       "resize-fields",
		Cols:     80,
		Rows:     24,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	if err := s.resize(120, 40); err != nil {
		t.Fatalf("resize: %v", err)
	}

	s.mu.Lock()
	cols := s.Cols
	rows := s.Rows
	s.mu.Unlock()

	if cols != 120 {
		t.Fatalf("expected Cols 120, got %d", cols)
	}
	if rows != 40 {
		t.Fatalf("expected Rows 40, got %d", rows)
	}
}

func TestSessionResizeClosedSession(t *testing.T) {
	s := &Session{
		ID:     "resize-closed",
		closed: true,
	}

	err := s.resize(120, 40)
	if err == nil {
		t.Fatal("expected error for closed session")
	}
	if !strings.Contains(err.Error(), "not active") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSessionResizeNilPTY(t *testing.T) {
	s := &Session{
		ID:  "resize-nil-pty",
		pty: nil,
	}

	err := s.resize(120, 40)
	if err == nil {
		t.Fatal("expected error for nil PTY")
	}
	if !strings.Contains(err.Error(), "not active") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSessionResizeMultipleTimes(t *testing.T) {
	s := &Session{
		ID:       "resize-multi",
		Cols:     80,
		Rows:     24,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	sizes := []struct {
		cols, rows uint16
	}{
		{120, 40},
		{80, 24},
		{200, 60},
		{1, 1},
	}

	for _, sz := range sizes {
		if err := s.resize(sz.cols, sz.rows); err != nil {
			t.Fatalf("resize to %dx%d: %v", sz.cols, sz.rows, err)
		}
	}
}

// ---------------------------------------------------------------------------
// setWinsize — unit test with real PTY
// ---------------------------------------------------------------------------

func TestSetWinsize(t *testing.T) {
	s := &Session{
		ID:       "setwinsize-test",
		Cols:     80,
		Rows:     24,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}
	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	if err := setWinsize(s.pty.Fd(), 132, 43); err != nil {
		t.Fatalf("setWinsize: %v", err)
	}
}

func TestSetWinsizeInvalidFd(t *testing.T) {
	err := setWinsize(999999, 80, 24)
	if err == nil {
		t.Fatal("expected error for invalid fd")
	}
}

// ---------------------------------------------------------------------------
// Full session lifecycle — write, read output, resize, close
// ---------------------------------------------------------------------------

func TestFullSessionLifecycle(t *testing.T) {
	m := NewManager()

	var outputBuf bytes.Buffer
	var outputMu sync.Mutex

	onOutput := func(data []byte) {
		outputMu.Lock()
		outputBuf.Write(data)
		outputMu.Unlock()
	}

	var closeCalled atomic.Int32
	onClose := func(err error) {
		closeCalled.Add(1)
	}

	// 1. Start session.
	err := m.StartSession("lifecycle-1", 80, 24, "/bin/sh", onOutput, onClose)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// 2. Verify session exists.
	s, ok := m.GetSession("lifecycle-1")
	if !ok || s == nil {
		t.Fatal("session not found")
	}

	// 3. Write a command.
	if err := m.WriteToSession("lifecycle-1", []byte("echo LIFECYCLE_OK\n")); err != nil {
		t.Fatalf("WriteToSession: %v", err)
	}

	// 4. Wait for output.
	deadline := time.After(5 * time.Second)
	for {
		outputMu.Lock()
		got := outputBuf.String()
		outputMu.Unlock()
		if strings.Contains(got, "LIFECYCLE_OK") {
			break
		}
		select {
		case <-deadline:
			outputMu.Lock()
			t.Fatalf("timed out waiting for output; got: %q", outputBuf.String())
			outputMu.Unlock()
		default:
			time.Sleep(50 * time.Millisecond)
		}
	}

	// 5. Resize.
	if err := m.ResizeSession("lifecycle-1", 120, 40); err != nil {
		t.Fatalf("ResizeSession: %v", err)
	}

	// 6. Close.
	if err := m.StopSession("lifecycle-1"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	// 7. Verify session removed.
	if m.GetSessionCount() != 0 {
		t.Fatal("expected 0 sessions after lifecycle test")
	}
}

// ---------------------------------------------------------------------------
// Multiple sessions simultaneously
// ---------------------------------------------------------------------------

func TestMultipleSessionsSimultaneous(t *testing.T) {
	m := NewManager()
	const numSessions = 5

	for i := 0; i < numSessions; i++ {
		id := fmt.Sprintf("multi-%d", i)
		err := m.StartSession(id, 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
		if err != nil {
			t.Fatalf("StartSession(%s): %v", id, err)
		}
	}

	if m.GetSessionCount() != numSessions {
		t.Fatalf("expected %d sessions, got %d", numSessions, m.GetSessionCount())
	}

	// Write to each session.
	for i := 0; i < numSessions; i++ {
		id := fmt.Sprintf("multi-%d", i)
		if err := m.WriteToSession(id, []byte("echo hi\n")); err != nil {
			t.Fatalf("WriteToSession(%s): %v", id, err)
		}
	}

	// Stop them one by one.
	for i := 0; i < numSessions; i++ {
		id := fmt.Sprintf("multi-%d", i)
		if err := m.StopSession(id); err != nil {
			t.Fatalf("StopSession(%s): %v", id, err)
		}
	}

	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0 sessions after stopping all, got %d", m.GetSessionCount())
	}
}

// ---------------------------------------------------------------------------
// Login shell flag (-l)
// ---------------------------------------------------------------------------

func TestSessionStartUsesLoginShell(t *testing.T) {
	s := &Session{
		ID:       "login-shell",
		Cols:     80,
		Rows:     24,
		Shell:    "/bin/sh",
		onOutput: func([]byte) {},
		onClose:  func(error) {},
	}

	if err := s.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.close()

	// The command should have been invoked with -l flag.
	foundLoginFlag := false
	for _, arg := range s.cmd.Args {
		if arg == "-l" {
			foundLoginFlag = true
			break
		}
	}
	if !foundLoginFlag {
		t.Fatalf("expected -l flag in command args: %v", s.cmd.Args)
	}
}
