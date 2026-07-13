package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
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

// watchdogTestHarness installs a tiny heartbeatWatchdogTimeout, clears the
// cross-invocation dump rate-limit state, and redirects the logger into a
// buffer. Everything is restored via t.Cleanup.
func watchdogTestHarness(t *testing.T, timeout time.Duration) *syncBuffer {
	t.Helper()
	prev := setHeartbeatWatchdogTimeout(timeout)
	t.Cleanup(func() { setHeartbeatWatchdogTimeout(prev) })

	resetHeartbeatWatchdogDumpState()
	t.Cleanup(resetHeartbeatWatchdogDumpState)

	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return buf
}

// runBlockedHeartbeat runs one sendHeartbeatWithWatchdog invocation whose
// send blocks until the watchdog has verifiably fired (one more "exceeded
// watchdog timeout" line in buf), then releases the send and waits for the
// invocation to complete. Holding the send open until the fire is observed
// makes the tests deterministic: if the send returned first, `done` and the
// timer could both be ready and Go's select would pick randomly.
func runBlockedHeartbeat(t *testing.T, buf *syncBuffer) {
	t.Helper()
	const fireMark = "heartbeat send exceeded watchdog timeout"
	before := strings.Count(buf.String(), fireMark)

	release := make(chan struct{})
	h := &Heartbeat{
		sendHeartbeatFn: func() { <-release },
	}
	done := make(chan struct{})
	go func() {
		h.sendHeartbeatWithWatchdog()
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for strings.Count(buf.String(), fireMark) <= before {
		if time.Now().After(deadline) {
			close(release)
			<-done
			t.Fatalf("watchdog did not fire within deadline, log:\n%s", buf.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	<-done
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

// TestSendHeartbeatWatchdogRateLimitsDumps verifies that within the dump
// interval only the FIRST watchdog fire emits a goroutine dump; subsequent
// fires log a cheap rate-limited warning with a suppressed counter instead
// (#2386: a degraded link must not produce one dump per heartbeat).
func TestSendHeartbeatWatchdogRateLimitsDumps(t *testing.T) {
	buf := watchdogTestHarness(t, 30*time.Millisecond)
	prev := setHeartbeatWatchdogDumpInterval(time.Hour)
	t.Cleanup(func() { setHeartbeatWatchdogDumpInterval(prev) })

	runBlockedHeartbeat(t, buf)
	runBlockedHeartbeat(t, buf)

	output := buf.String()
	if got := strings.Count(output, "goroutines="); got != 1 {
		t.Fatalf("expected exactly 1 goroutine dump within the interval, got %d:\n%s", got, output)
	}
	if !strings.Contains(output, "goroutine dump rate-limited") {
		t.Fatalf("expected a rate-limited warning for the second fire, got:\n%s", output)
	}
	if !strings.Contains(output, "suppressed_dumps=1") {
		t.Fatalf("expected suppressed_dumps=1 on the rate-limited warning, got:\n%s", output)
	}
}

// TestSendHeartbeatWatchdogDumpsAgainAfterInterval verifies that once the
// dump interval elapses, the watchdog dumps again — and reports how many
// fires were suppressed in between.
func TestSendHeartbeatWatchdogDumpsAgainAfterInterval(t *testing.T) {
	buf := watchdogTestHarness(t, 30*time.Millisecond)
	// A generous interval so the back-to-back second fire deterministically
	// lands inside it even on a heavily loaded runner; the elapse sleep only
	// errs in the safe direction (longer = interval definitely over).
	prev := setHeartbeatWatchdogDumpInterval(time.Second)
	t.Cleanup(func() { setHeartbeatWatchdogDumpInterval(prev) })

	runBlockedHeartbeat(t, buf)         // dump #1
	runBlockedHeartbeat(t, buf)         // suppressed (well within 1s)
	time.Sleep(1200 * time.Millisecond) // interval elapses
	runBlockedHeartbeat(t, buf)         // dump #2

	output := buf.String()
	if got := strings.Count(output, "dumping goroutine stacks"); got != 2 {
		t.Fatalf("expected 2 goroutine dumps across the interval, got %d:\n%s", got, output)
	}
	if !strings.Contains(output, "suppressed_dumps_since_last=1") {
		t.Fatalf("expected the second dump to report 1 suppressed fire, got:\n%s", output)
	}
}

// TestHeartbeatWatchdogTryAcquireDumpConcurrent verifies that overlapping
// watchdog goroutines racing for one dump slot yield exactly one winner.
func TestHeartbeatWatchdogTryAcquireDumpConcurrent(t *testing.T) {
	resetHeartbeatWatchdogDumpState()
	t.Cleanup(resetHeartbeatWatchdogDumpState)

	now := time.Now()
	const n = 32
	var winners atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if heartbeatWatchdogTryAcquireDump(now, time.Hour) {
				winners.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := winners.Load(); got != 1 {
		t.Fatalf("expected exactly 1 winner among %d concurrent acquisitions, got %d", n, got)
	}
}

// TestHeartbeatWatchdogTryAcquireDumpInterval pins the interval boundary
// semantics with injected times (no sleeps).
func TestHeartbeatWatchdogTryAcquireDumpInterval(t *testing.T) {
	resetHeartbeatWatchdogDumpState()
	t.Cleanup(resetHeartbeatWatchdogDumpState)

	base := time.Now()
	interval := 10 * time.Minute

	if !heartbeatWatchdogTryAcquireDump(base, interval) {
		t.Fatal("first acquisition must succeed")
	}
	if heartbeatWatchdogTryAcquireDump(base.Add(interval-time.Nanosecond), interval) {
		t.Fatal("acquisition 1ns before the interval elapses must be suppressed")
	}
	if !heartbeatWatchdogTryAcquireDump(base.Add(interval), interval) {
		t.Fatal("acquisition exactly at the interval must succeed")
	}
}

// TestHeartbeatWatchdogProductionDefaults pins the shipped defaults: the
// 90s timeout IS the #2386 fix (it must clear the ~60-65s legitimate
// worst case of 30s primary POST + 30s backup probe + collection overhead).
func TestHeartbeatWatchdogProductionDefaults(t *testing.T) {
	if got := heartbeatWatchdogTimeout(); got != 90*time.Second {
		t.Fatalf("default watchdog timeout = %v, want 90s (must exceed the ~60-65s legitimate worst case)", got)
	}
	if got := heartbeatWatchdogDumpInterval(); got != 10*time.Minute {
		t.Fatalf("default dump interval = %v, want 10m", got)
	}
}

// TestTruncateGoroutineDump verifies the size cap cuts at a goroutine
// boundary and appends a truncation marker.
func TestTruncateGoroutineDump(t *testing.T) {
	short := "goroutine 1 [running]:\nmain.main()\n\t/x/main.go:1 +0x1"
	if got := truncateGoroutineDump(short, 1024); got != short {
		t.Fatalf("under-limit dump must be unchanged, got:\n%s", got)
	}

	var sb strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&sb, "goroutine %d [select]:\nsome.pkg.Func()\n\t/x/file.go:%d +0x2f\n\n", i+1, i+10)
	}
	long := strings.TrimSuffix(sb.String(), "\n\n")
	max := 1024
	got := truncateGoroutineDump(long, max)
	if len(got) > max+64 {
		t.Fatalf("truncated dump too large: %d bytes (max %d + marker)", len(got), max)
	}
	if !strings.Contains(got, "[truncated") {
		t.Fatalf("expected truncation marker, got:\n%s", got)
	}
	body := got[:strings.Index(got, "\n... [truncated")]
	if !strings.HasSuffix(body, "+0x2f") {
		t.Fatalf("expected cut at a goroutine boundary (complete last frame), got tail: %q", body[len(body)-40:])
	}
}

// TestWatchdogDumpFitsAPIFieldsLimit proves the size cap leaves headroom
// under the API's 32,000-stringified-char `fields` ceiling even for a
// worst-case-escaping dump (every char JSON-escapes to two chars).
func TestWatchdogDumpFitsAPIFieldsLimit(t *testing.T) {
	worst := strings.Repeat("\"\n", heartbeatWatchdogMaxDumpBytes/2)
	dump := truncateGoroutineDump(worst, heartbeatWatchdogMaxDumpBytes)
	fields := map[string]any{
		"elapsed_ms":                  int64(999999),
		"timeout_ms":                  int64(90000),
		"goroutine_count":             12345,
		"suppressed_dumps_since_last": int64(9999),
		"goroutines":                  dump,
	}
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) > 32000 {
		t.Fatalf("worst-case watchdog fields serialize to %d bytes, exceeding the API's 32000-char limit", len(b))
	}
}
