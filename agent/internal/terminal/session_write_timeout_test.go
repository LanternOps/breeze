package terminal

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// wedgedWriteCloser blocks every Write until Close is called — the shape of a
// PTY whose foreground process stopped reading (e.g. Ctrl-S flow control).
type wedgedWriteCloser struct {
	mu       sync.Mutex
	unblock  chan struct{}
	closed   bool
	writes   int
	released chan struct{} // closed when a blocked Write returns
}

func newWedgedWriteCloser() *wedgedWriteCloser {
	return &wedgedWriteCloser{
		unblock:  make(chan struct{}),
		released: make(chan struct{}),
	}
}

func (w *wedgedWriteCloser) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.writes++
	w.mu.Unlock()
	<-w.unblock
	close(w.released)
	return len(p), nil
}

func (w *wedgedWriteCloser) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed {
		w.closed = true
		close(w.unblock)
	}
	return nil
}

// TestSessionWriteTimesOutOnWedgedPTY is the regression test for issue #2387:
// a PTY/stdin write that never completes must not block write() forever (it
// used to, while holding s.mu — deadlocking close() and every later terminal
// command for the session, and pinning a command worker for the process
// lifetime). The write must fail within the bounded wait and the session must
// be marked dead.
func TestSessionWriteTimesOutOnWedgedPTY(t *testing.T) {
	w := newWedgedWriteCloser()
	s := &Session{ID: "wedged", stdin: w, writeTimeout: 100 * time.Millisecond}

	errCh := make(chan error, 1)
	go func() { errCh <- s.write([]byte("x")) }()

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("expected write-timeout error, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("write still blocked long after the timeout — worker would be wedged")
	}

	// The timeout path closes the session asynchronously; close() must both
	// mark it closed and Close() the writer, which unblocks the wedged write.
	deadline := time.After(5 * time.Second)
	for {
		s.mu.Lock()
		closed := s.closed
		s.mu.Unlock()
		if closed {
			break
		}
		select {
		case <-deadline:
			t.Fatal("session never marked closed after write timeout")
		case <-time.After(10 * time.Millisecond):
		}
	}
	select {
	case <-w.released:
	case <-time.After(5 * time.Second):
		t.Fatal("wedged writer goroutine never released after session close")
	}

	// Later writes must fail fast on the closed session, not queue behind the
	// wedged writer (the old deadlock).
	if err := s.write([]byte("y")); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("expected closed-session error, got %v", err)
	}
}

// TestSessionCloseNotBlockedByWedgedWrite verifies close() no longer waits on
// s.mu behind a blocked write.
func TestSessionCloseNotBlockedByWedgedWrite(t *testing.T) {
	w := newWedgedWriteCloser()
	// Long timeout: close() must win the race, not the bounded wait.
	s := &Session{ID: "close-race", stdin: w, writeTimeout: 10 * time.Second}

	writeErr := make(chan error, 1)
	go func() { writeErr <- s.write([]byte("x")) }()

	// Wait until the writer goroutine is actually inside Write.
	deadline := time.After(2 * time.Second)
	for {
		w.mu.Lock()
		n := w.writes
		w.mu.Unlock()
		if n > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("write never started")
		case <-time.After(5 * time.Millisecond):
		}
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- s.close() }()

	select {
	case <-closeDone:
		// close() completed while the write was still wedged — no deadlock.
	case <-time.After(2 * time.Second):
		t.Fatal("close() blocked behind a wedged write")
	}

	// Closing the stdin pipe unblocks the wedged write.
	select {
	case <-writeErr:
	case <-time.After(5 * time.Second):
		t.Fatal("write never returned after close")
	}
}
