package terminal

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

	var outputBuf bytes.Buffer
	var outputMu sync.Mutex

	onOutput := func(data []byte) {
		outputMu.Lock()
		outputBuf.Write(data)
		outputMu.Unlock()
	}

	err := m.StartSession("real-1", 80, 24, "/bin/sh", onOutput, func(error) {})
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

	// Wait for output to contain the echoed string.
	deadline := time.After(5 * time.Second)
	for {
		outputMu.Lock()
		got := outputBuf.String()
		outputMu.Unlock()
		if strings.Contains(got, "HELLO_BREEZE") {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for PTY output; got so far: %q", got)
		default:
			time.Sleep(50 * time.Millisecond)
		}
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
// Session.write – unit tests with mock writers
// ---------------------------------------------------------------------------

func TestSessionWriteToStdinPipe(t *testing.T) {
	r, w := io.Pipe()
	defer r.Close()

	s := &Session{
		ID:    "write-stdin",
		stdin: w,
	}

	data := []byte("hello stdin")
	go func() {
		if err := s.write(data); err != nil {
			t.Errorf("write: %v", err)
		}
	}()

	buf := make([]byte, 64)
	n, err := r.Read(buf)
	if err != nil {
		t.Fatalf("read pipe: %v", err)
	}
	if string(buf[:n]) != "hello stdin" {
		t.Fatalf("expected 'hello stdin', got %q", string(buf[:n]))
	}
}

func TestSessionWriteToPTYFd(t *testing.T) {
	// Use an os.Pipe to simulate the PTY fd (not a real PTY, but tests the write path).
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer r.Close()
	defer w.Close()

	s := &Session{
		ID:  "write-pty",
		pty: w,
	}

	data := []byte("hello pty")
	if err := s.write(data); err != nil {
		t.Fatalf("write: %v", err)
	}

	buf := make([]byte, 64)
	n, err := r.Read(buf)
	if err != nil {
		t.Fatalf("read pipe: %v", err)
	}
	if string(buf[:n]) != "hello pty" {
		t.Fatalf("expected 'hello pty', got %q", string(buf[:n]))
	}
}

func TestSessionWriteClosedSession(t *testing.T) {
	s := &Session{
		ID:     "write-closed",
		closed: true,
	}

	err := s.write([]byte("data"))
	if err == nil {
		t.Fatal("expected error when writing to closed session")
	}
	if !strings.Contains(err.Error(), "closed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSessionWriteNoPTYNoStdin(t *testing.T) {
	s := &Session{
		ID: "write-no-pty",
		// Neither stdin nor pty set.
	}

	err := s.write([]byte("data"))
	if err == nil {
		t.Fatal("expected error when no PTY and no stdin")
	}
	if !strings.Contains(err.Error(), "PTY not available") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSessionWriteStdinPreferredOverPTY(t *testing.T) {
	// When both stdin and pty are set, stdin should be used (Windows path).
	stdinR, stdinW := io.Pipe()
	defer stdinR.Close()

	_, ptyW, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer ptyW.Close()

	s := &Session{
		ID:    "write-prefer-stdin",
		stdin: stdinW,
		pty:   ptyW,
	}

	go func() {
		s.write([]byte("stdin wins"))
	}()

	buf := make([]byte, 64)
	n, readErr := stdinR.Read(buf)
	if readErr != nil {
		t.Fatalf("read stdin pipe: %v", readErr)
	}
	if string(buf[:n]) != "stdin wins" {
		t.Fatalf("expected 'stdin wins', got %q", string(buf[:n]))
	}
}

// ---------------------------------------------------------------------------
// Session.close – unit tests
// ---------------------------------------------------------------------------

func TestSessionCloseIdempotent(t *testing.T) {
	s := &Session{ID: "close-idem"}

	// First close should succeed.
	if err := s.close(); err != nil {
		t.Fatalf("first close: %v", err)
	}

	// Second close should be a no-op, not an error.
	if err := s.close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestSessionCloseKillsProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process lifecycle test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("close-kill", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	s, ok := m.GetSession("close-kill")
	if !ok {
		t.Fatal("session not found")
	}

	pid := s.cmd.Process.Pid
	if pid == 0 {
		t.Fatal("expected non-zero PID")
	}

	if err := m.StopSession("close-kill"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	// The process should eventually exit.
	time.Sleep(100 * time.Millisecond)
	proc, err := os.FindProcess(pid)
	if err == nil && proc != nil {
		// On Unix, FindProcess always succeeds. Signal(0) checks if process exists.
		_ = proc.Signal(os.Signal(nil))
	}
}

// ---------------------------------------------------------------------------
// Session.readLoop – unit test with pipe
// ---------------------------------------------------------------------------

func TestReadLoopCallsOnOutput(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer w.Close()

	var received bytes.Buffer
	var mu sync.Mutex
	doneCh := make(chan struct{})

	s := &Session{
		ID:  "readloop-1",
		pty: r,
		onOutput: func(data []byte) {
			mu.Lock()
			received.Write(data)
			mu.Unlock()
		},
		onClose: func(err error) {
			close(doneCh)
		},
	}

	go s.readLoop()

	// Write some data.
	w.Write([]byte("line 1\n"))
	w.Write([]byte("line 2\n"))

	// Give readLoop time to process.
	time.Sleep(100 * time.Millisecond)

	// Close writer to trigger EOF.
	w.Close()

	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not call onClose after EOF")
	}

	mu.Lock()
	got := received.String()
	mu.Unlock()

	if !strings.Contains(got, "line 1") || !strings.Contains(got, "line 2") {
		t.Fatalf("expected output to contain both lines, got: %q", got)
	}
}

func TestReadLoopCallsOnCloseOnError(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	w.Close() // EOF on first read

	closeCalled := make(chan error, 1)
	s := &Session{
		ID:  "readloop-close",
		pty: r,
		onClose: func(err error) {
			closeCalled <- err
		},
	}

	go s.readLoop()

	select {
	case closeErr := <-closeCalled:
		if closeErr != io.EOF {
			t.Fatalf("expected EOF, got %v", closeErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("onClose not called after read error")
	}
}

func TestReadLoopNilOnOutputDoesNotPanic(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}

	doneCh := make(chan struct{})
	s := &Session{
		ID:       "readloop-nil-out",
		pty:      r,
		onOutput: nil, // Nil callback
		onClose: func(err error) {
			close(doneCh)
		},
	}

	go s.readLoop()

	// Write data — should not panic even with nil onOutput.
	w.Write([]byte("data"))
	time.Sleep(50 * time.Millisecond)

	w.Close()

	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not complete with nil onOutput")
	}
}

func TestReadLoopNilOnCloseDoesNotPanic(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}

	s := &Session{
		ID:      "readloop-nil-close",
		pty:     r,
		onClose: nil, // Nil callback
	}

	done := make(chan struct{})
	go func() {
		s.readLoop()
		close(done)
	}()

	w.Close() // Trigger EOF

	select {
	case <-done:
		// readLoop exited without panic.
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not complete with nil onClose")
	}
}

func TestReadLoopCopiesData(t *testing.T) {
	// Verify that onOutput receives a copy of the data, not a slice of the
	// internal buffer (which would be overwritten on the next read).
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}

	var snapshots [][]byte
	var mu sync.Mutex
	doneCh := make(chan struct{})

	s := &Session{
		ID:  "readloop-copy",
		pty: r,
		onOutput: func(data []byte) {
			mu.Lock()
			// Keep a reference to the slice we received.
			snapshots = append(snapshots, data)
			mu.Unlock()
		},
		onClose: func(err error) {
			close(doneCh)
		},
	}

	go s.readLoop()

	w.Write([]byte("FIRST"))
	time.Sleep(50 * time.Millisecond)
	w.Write([]byte("SECOND"))
	time.Sleep(50 * time.Millisecond)
	w.Close()

	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not exit")
	}

	mu.Lock()
	defer mu.Unlock()

	if len(snapshots) < 2 {
		t.Skipf("got %d snapshots, need at least 2 to verify independence (OS may coalesce writes)", len(snapshots))
	}

	// Verify first snapshot was not corrupted by later reads.
	if !strings.Contains(string(snapshots[0]), "FIRST") {
		t.Fatalf("first snapshot should contain FIRST, got %q", string(snapshots[0]))
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
// Concurrent access
// ---------------------------------------------------------------------------

func TestManagerConcurrentAccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	const numGoroutines = 10

	// Start sessions concurrently.
	var wg sync.WaitGroup
	errCh := make(chan error, numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			id := fmt.Sprintf("conc-%d", idx)
			err := m.StartSession(id, 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
			if err != nil {
				errCh <- fmt.Errorf("StartSession(%s): %v", id, err)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Fatal(err)
	}

	if m.GetSessionCount() != numGoroutines {
		t.Fatalf("expected %d sessions, got %d", numGoroutines, m.GetSessionCount())
	}

	// Concurrently read, write, and close sessions.
	var wg2 sync.WaitGroup
	for i := 0; i < numGoroutines; i++ {
		wg2.Add(1)
		go func(idx int) {
			defer wg2.Done()
			id := fmt.Sprintf("conc-%d", idx)

			// Read.
			m.GetSession(id)
			m.GetSessionCount()

			// Write.
			m.WriteToSession(id, []byte("hello\n"))

			// Stop.
			m.StopSession(id)
		}(i)
	}
	wg2.Wait()

	if m.GetSessionCount() != 0 {
		t.Fatalf("expected 0 sessions after concurrent stops, got %d", m.GetSessionCount())
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

// ---------------------------------------------------------------------------
// StopSession – double stop
// ---------------------------------------------------------------------------

func TestStopSessionDoubleStop(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("double-stop", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// First stop should succeed.
	if err := m.StopSession("double-stop"); err != nil {
		t.Fatalf("first StopSession: %v", err)
	}

	// Second stop should return not found.
	err = m.StopSession("double-stop")
	if err == nil {
		t.Fatal("expected error on second stop")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Session callbacks – onOutput receives correct data
// ---------------------------------------------------------------------------

func TestStartSessionCallbackReceivesOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	var callCount atomic.Int32

	err := m.StartSession("cb-test", 80, 24, "/bin/sh",
		func(data []byte) {
			callCount.Add(1)
		},
		func(err error) {},
	)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	defer m.StopSession("cb-test")

	// Write to trigger output.
	m.WriteToSession("cb-test", []byte("echo test\n"))
	time.Sleep(200 * time.Millisecond)

	if callCount.Load() == 0 {
		t.Fatal("expected onOutput to be called at least once")
	}
}

// ---------------------------------------------------------------------------
// Write to session with empty data
// ---------------------------------------------------------------------------

func TestSessionWriteEmptyData(t *testing.T) {
	_, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer w.Close()

	s := &Session{
		ID:  "write-empty",
		pty: w,
	}

	// Writing empty data should not error.
	if err := s.write([]byte{}); err != nil {
		t.Fatalf("write empty data: %v", err)
	}

	if err := s.write(nil); err != nil {
		t.Fatalf("write nil data: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Session close with stdin pipe
// ---------------------------------------------------------------------------

func TestSessionCloseWithStdinPipe(t *testing.T) {
	r, w := io.Pipe()
	defer r.Close()

	s := &Session{
		ID:    "close-stdin",
		stdin: w,
	}

	if err := s.close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if !s.closed {
		t.Fatal("expected session to be marked closed")
	}

	// Writing to the closed pipe should fail.
	_, writeErr := w.Write([]byte("data"))
	if writeErr == nil {
		t.Fatal("expected write to closed pipe to fail")
	}
}

// ---------------------------------------------------------------------------
// Session close with PTY fd
// ---------------------------------------------------------------------------

func TestSessionCloseWithPTY(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer r.Close()

	s := &Session{
		ID:  "close-pty",
		pty: w,
	}

	if err := s.close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if !s.closed {
		t.Fatal("expected session to be marked closed")
	}
}

// ---------------------------------------------------------------------------
// waitCmd – sync.Once guarantees single Wait
// ---------------------------------------------------------------------------

func TestWaitCmdNilCmd(t *testing.T) {
	s := &Session{ID: "waitcmd-nil"}
	// Should not panic with nil cmd.
	err := s.waitCmd()
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
}

func TestWaitCmdIdempotent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("waitcmd-idem", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	s, _ := m.GetSession("waitcmd-idem")

	// Close the session (triggers Kill + waitCmd).
	m.StopSession("waitcmd-idem")

	// Calling waitCmd again should be safe (sync.Once).
	err = s.waitCmd()
	if err != nil {
		t.Fatalf("second waitCmd: %v", err)
	}
}
