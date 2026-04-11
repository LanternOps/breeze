package heartbeat

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// syncBuffer is a goroutine-safe wrapper around bytes.Buffer for concurrent
// writers (the test goroutine and the watchdog goroutine both emit logs).
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// watchdogTestHarness installs a tiny heartbeatWatchdogTimeout and redirects
// the logger into a buffer. Everything is restored via t.Cleanup.
func watchdogTestHarness(t *testing.T, timeout time.Duration) *syncBuffer {
	t.Helper()
	prev := setHeartbeatWatchdogTimeout(timeout)
	t.Cleanup(func() { setHeartbeatWatchdogTimeout(prev) })

	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return buf
}

// TestSendHeartbeatWatchdogFiresWhenBlocked verifies that a sendHeartbeat
// impl that blocks longer than heartbeatWatchdogTimeout causes the watchdog
// to log a stack dump.
func TestSendHeartbeatWatchdogFiresWhenBlocked(t *testing.T) {
	buf := watchdogTestHarness(t, 50*time.Millisecond)

	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once

	h := &Heartbeat{
		sendHeartbeatFn: func() {
			once.Do(func() { close(started) })
			<-release
		},
	}

	done := make(chan struct{})
	go func() {
		h.sendHeartbeatWithWatchdog()
		close(done)
	}()

	<-started
	// Wait well past the 50ms watchdog timeout so the goroutine-dump warn fires.
	time.Sleep(150 * time.Millisecond)
	close(release)
	<-done

	output := buf.String()
	if !strings.Contains(output, "heartbeat send exceeded watchdog timeout") {
		t.Fatalf("expected watchdog warning, got:\n%s", output)
	}
	if !strings.Contains(output, "goroutines=") {
		t.Fatalf("expected goroutines= stack-dump field, got:\n%s", output)
	}
}

// TestSendHeartbeatWatchdogDoesNotFireOnFastPath verifies that a
// sendHeartbeat that returns quickly does NOT trip the watchdog warning.
func TestSendHeartbeatWatchdogDoesNotFireOnFastPath(t *testing.T) {
	buf := watchdogTestHarness(t, 100*time.Millisecond)

	h := &Heartbeat{
		sendHeartbeatFn: func() {
			// Return immediately.
		},
	}

	h.sendHeartbeatWithWatchdog()

	// Give any late-firing watchdog goroutine a chance to warn (it should NOT).
	time.Sleep(250 * time.Millisecond)

	if strings.Contains(buf.String(), "heartbeat send exceeded watchdog timeout") {
		t.Fatalf("watchdog should not fire on fast path, got:\n%s", buf.String())
	}
}

// TestSendHeartbeatWatchdogCancelsOnPanic verifies that a panic inside
// sendHeartbeat still closes the watchdog done channel via the deferred
// close(done), so the watchdog goroutine does not emit a misleading
// "exceeded" warning after the wrapper unwinds the panic.
func TestSendHeartbeatWatchdogCancelsOnPanic(t *testing.T) {
	buf := watchdogTestHarness(t, 50*time.Millisecond)

	h := &Heartbeat{
		sendHeartbeatFn: func() {
			panic("intentional test panic")
		},
	}

	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("expected panic to propagate out of watchdog wrapper")
			}
		}()
		h.sendHeartbeatWithWatchdog()
	}()

	// Wait longer than the watchdog timeout. The deferred close(done) must
	// have fired as the panic unwound, so no warning should be emitted.
	time.Sleep(150 * time.Millisecond)

	if strings.Contains(buf.String(), "heartbeat send exceeded watchdog timeout") {
		t.Fatalf("watchdog fired after panic unwound; deferred close(done) must cancel it:\n%s",
			buf.String())
	}
}
