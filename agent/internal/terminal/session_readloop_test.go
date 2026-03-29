package terminal

import (
	"bytes"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

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
