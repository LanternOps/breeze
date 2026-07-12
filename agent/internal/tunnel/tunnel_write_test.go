package tunnel

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func newPipeSession(t *testing.T, writeTimeout time.Duration) (*Session, net.Conn) {
	t.Helper()
	local, remote := net.Pipe()
	s := &Session{
		ID:           "test-tunnel",
		TargetHost:   "127.0.0.1",
		TargetPort:   5900,
		TunnelType:   "vnc",
		conn:         local,
		writeTimeout: writeTimeout,
		done:         make(chan struct{}),
		createdAt:    time.Now(),
	}
	t.Cleanup(func() {
		s.Close()
		remote.Close()
	})
	return s, remote
}

func TestSessionWriteSucceedsWithDrainingTarget(t *testing.T) {
	s, remote := newPipeSession(t, 2*time.Second)

	got := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 64)
		n, err := remote.Read(buf)
		if err != nil {
			t.Errorf("remote read: %v", err)
			return
		}
		got <- buf[:n]
	}()

	if err := s.Write([]byte("hello")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	select {
	case b := <-got:
		if string(b) != "hello" {
			t.Fatalf("target received %q, want %q", b, "hello")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("target never received the write")
	}
	if s.BytesSent() != 5 {
		t.Fatalf("BytesSent = %d, want 5", s.BytesSent())
	}
}

// TestSessionWriteTimesOutOnStalledTarget is the regression test for issue
// #2387: a target that never drains must not block Write forever — the write
// must fail within the deadline and the session must be closed so the calling
// command worker (and its payload) is released.
func TestSessionWriteTimesOutOnStalledTarget(t *testing.T) {
	s, _ := newPipeSession(t, 100*time.Millisecond) // net.Pipe with no reader: Write blocks until deadline

	errCh := make(chan error, 1)
	go func() { errCh <- s.Write([]byte("stalled")) }()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected timeout error, got nil")
		}
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("expected net timeout error, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Write still blocked long after the write deadline — worker would be wedged")
	}

	// The session must be torn down after a write timeout.
	select {
	case <-s.done:
	default:
		t.Fatal("session not closed after write timeout")
	}

	// The recorded close reason must carry the write-timeout cause so
	// readLoop's onClose reports it (not the read-side symptom).
	reason, ok := s.closeReason.Load().(error)
	if !ok || !strings.Contains(reason.Error(), "timed out") {
		t.Fatalf("expected closeReason to record the write timeout, got %v", reason)
	}
	if err := s.Write([]byte("after")); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("expected closed-session error on subsequent write, got %v", err)
	}
}
