package terminal

import (
	"io"
	"os"
	"strings"
	"testing"
)

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
