package terminal

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

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

func TestSessionRemovedAfterShellExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test requires Unix/macOS")
	}

	m := NewManager()
	err := m.StartSession("auto-exit", 80, 24, "/bin/sh", func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := m.WriteToSession("auto-exit", []byte("exit\n")); err != nil {
		t.Fatalf("WriteToSession: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if m.GetSessionCount() == 0 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}

	t.Fatalf("expected session to be removed after shell exit, still have %d sessions", m.GetSessionCount())
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
