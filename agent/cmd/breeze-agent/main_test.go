package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestHelperWarnLimiterBudget verifies that the first `limit` calls with the
// same message all emit WARN (emit=true, suppressed=0), and that the (limit+1)th
// call does NOT emit a WARN when the info interval has not elapsed.
func TestHelperWarnLimiterBudget(t *testing.T) {
	t.Parallel()

	// limit=3, 5-minute window (matches production default)
	lim := newHelperWarnLimiter(3, 5*time.Minute)
	msg := "connect: connect to /var/run/breeze.sock: connection refused"
	now := time.Now()

	// Calls 1–3 should all emit WARN.
	for i := 1; i <= 3; i++ {
		emit, suppressed := lim.shouldLog(msg, now)
		if !emit {
			t.Errorf("call %d: expected emit=true, got false", i)
		}
		if suppressed != 0 {
			t.Errorf("call %d: expected suppressed=0, got %d", i, suppressed)
		}
		now = now.Add(time.Second)
	}

	// Call 4: over budget, info interval has not elapsed → (false, 0).
	// NOTE: suppressedSinceInfo was 0 going in, incremented to 1, then INFO
	// would only fire if lastInfoEmit is zero. But we check: lastInfoEmit is
	// zero on entry here, so the first over-budget call WILL return (false, N>0).
	// Actually, re-reading the code: on call 4, suppressed++ → suppressed=1,
	// suppressedSinceInfo++ → 1. lastInfoEmit.IsZero() is true, so it returns
	// (false, 1) and resets suppressedSinceInfo to 0. This matches the
	// "INFO fires immediately at first suppression" behavior.
	emit4, sup4 := lim.shouldLog(msg, now)
	if emit4 {
		t.Errorf("call 4: expected emit=false (over budget), got true")
	}
	// The limiter fires an INFO summary immediately on first suppression
	// (lastInfoEmit was zero). sup4 should equal 1.
	if sup4 != 1 {
		t.Errorf("call 4: expected suppressed=1 (immediate first INFO), got %d", sup4)
	}
}

// TestHelperWarnLimiterSuppressedNoInfoYet verifies that after the first INFO
// fires, subsequent over-budget calls within the info interval return (false, 0).
func TestHelperWarnLimiterSuppressedNoInfoYet(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(3, 5*time.Minute)
	msg := "some error"
	now := time.Now()

	// Exhaust warn budget (3 warns + 1 INFO-emitting call).
	for i := 0; i < 3; i++ {
		lim.shouldLog(msg, now) //nolint: calls 1-3
		now = now.Add(time.Second)
	}
	lim.shouldLog(msg, now) // call 4: first INFO fires, resets suppressedSinceInfo
	now = now.Add(time.Second)

	// Call 5: within info interval → (false, 0).
	emit, sup := lim.shouldLog(msg, now)
	if emit {
		t.Errorf("call 5: expected emit=false, got true")
	}
	if sup != 0 {
		t.Errorf("call 5: expected suppressed=0 (inside info interval), got %d", sup)
	}
}

// TestHelperWarnLimiterMultipleInfos verifies that each INFO emission within a
// single 5-minute window reports only the count since the last INFO, not cumulative.
func TestHelperWarnLimiterMultipleInfos(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(1, 10*time.Minute) // limit=1 so budget exhausts at call 2
	msg := "persistent error"
	now := time.Now()

	// Call 1: first warn (under budget).
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)

	// Call 2: over budget, first INFO fires immediately (lastInfoEmit was zero).
	_, sup1 := lim.shouldLog(msg, now)
	if sup1 != 1 {
		t.Fatalf("first INFO: expected suppressed=1, got %d", sup1)
	}
	now = now.Add(time.Second)

	// Calls 3-5: accumulate 3 more suppressions within infoInterval.
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)

	// Advance past infoInterval (60s) so the next call triggers a second INFO.
	now = now.Add(61 * time.Second)

	// Call 6: second INFO should report 4 (calls 3-5 plus this call = 4 suppressed since last INFO).
	_, sup2 := lim.shouldLog(msg, now)
	if sup2 != 4 {
		// 3 accumulated + 1 from this call = 4 suppressed since last INFO
		t.Errorf("second INFO: expected suppressed=4 (accumulated since last INFO), got %d", sup2)
	}
}

// TestHelperWarnLimiterDifferentMessages verifies that different error messages
// are tracked independently within the same window.
func TestHelperWarnLimiterDifferentMessages(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(2, 5*time.Minute)
	msgA := "error A: connection refused"
	msgB := "error B: tls handshake failure"
	now := time.Now()

	// Exhaust budget for msgA (2 warns).
	for i := 0; i < 2; i++ {
		lim.shouldLog(msgA, now)
		now = now.Add(time.Second)
	}

	// Next msgA call is over budget for A.
	emitA, _ := lim.shouldLog(msgA, now)
	if emitA {
		t.Errorf("msgA call 3: expected emit=false (over budget), got true")
	}
	now = now.Add(time.Second)

	// msgB is a new message — it gets its own fresh budget.
	// Window rolls over when msg changes, so call 1 of msgB should emit.
	emitB, supB := lim.shouldLog(msgB, now)
	if !emitB {
		t.Errorf("msgB call 1: expected emit=true (fresh message), got false")
	}
	if supB != 0 {
		t.Errorf("msgB call 1: expected suppressed=0, got %d", supB)
	}
}

// TestHelperWarnLimiterWindowRollover verifies that after the 5-minute window
// elapses, the limiter resets and emits WARNs again.
func TestHelperWarnLimiterWindowRollover(t *testing.T) {
	t.Parallel()

	// Use a 100ms window — with injectable clock we don't need a real sleep.
	lim := newHelperWarnLimiter(2, 100*time.Millisecond)
	msg := "some persistent error"
	now := time.Now()

	// Exhaust budget.
	lim.shouldLog(msg, now)
	now = now.Add(10 * time.Millisecond)
	lim.shouldLog(msg, now)
	now = now.Add(10 * time.Millisecond)

	// Over budget.
	emit3, _ := lim.shouldLog(msg, now)
	if emit3 {
		t.Errorf("call 3: expected emit=false (over budget), got true")
	}

	// Advance past the 100ms window without any real sleep.
	now = now.Add(150 * time.Millisecond)

	// Window rolled over → fresh budget, should emit again.
	emit4, sup4 := lim.shouldLog(msg, now)
	if !emit4 {
		t.Errorf("post-rollover call: expected emit=true (fresh window), got false")
	}
	if sup4 != 0 {
		t.Errorf("post-rollover call: expected suppressed=0, got %d", sup4)
	}
}

// TestHelperWarnLimiterReset verifies that explicit reset() clears all state
// so the next call treats the message as brand-new.
func TestHelperWarnLimiterReset(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(2, 5*time.Minute)
	msg := "connection reset by peer"
	now := time.Now()

	// Exhaust budget.
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)
	lim.shouldLog(msg, now)
	now = now.Add(time.Second)
	emit3, _ := lim.shouldLog(msg, now)
	if emit3 {
		t.Errorf("pre-reset call 3: expected emit=false (over budget)")
	}
	now = now.Add(time.Second)

	// Reset clears all state.
	lim.reset()

	// Next call should behave as first call ever.
	emit1, sup1 := lim.shouldLog(msg, now)
	if !emit1 {
		t.Errorf("post-reset call 1: expected emit=true, got false")
	}
	if sup1 != 0 {
		t.Errorf("post-reset call 1: expected suppressed=0, got %d", sup1)
	}
	now = now.Add(time.Second)

	// Second call should also emit (still within budget of 2).
	emit2, sup2 := lim.shouldLog(msg, now)
	if !emit2 {
		t.Errorf("post-reset call 2: expected emit=true, got false")
	}
	if sup2 != 0 {
		t.Errorf("post-reset call 2: expected suppressed=0, got %d", sup2)
	}
}

// TestHelperWarnLimiterConcurrent verifies that concurrent shouldLog calls do
// not race. Run with go test -race to catch data races.
func TestHelperWarnLimiterConcurrent(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(3, 5*time.Minute)
	msg := "concurrent error"

	var wg sync.WaitGroup
	const goroutines = 20
	const callsPerGoroutine = 50

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < callsPerGoroutine; j++ {
				// We don't care about the exact return values here —
				// just verify that concurrent access doesn't race or panic.
				lim.shouldLog(msg, time.Now())
			}
		}()
	}

	wg.Wait()
}

// TestHelperWarnLimiterResetConcurrent verifies that reset() is safe to call
// concurrently with shouldLog.
func TestHelperWarnLimiterResetConcurrent(t *testing.T) {
	t.Parallel()

	lim := newHelperWarnLimiter(3, 5*time.Minute)
	msg := "some error"

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			lim.shouldLog(msg, time.Now())
		}
	}()

	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			lim.reset()
		}
	}()

	wg.Wait()
}

// TestTrimEnrollInputs verifies that the template-MSI space-padded sentinel
// format is stripped before the values reach url.Parse / HTTP request
// construction. Regression test for the v0.62.22 → v0.62.23 hotfix where the
// direct-exe enrollment CA introduced in #410 dropped the .Trim() calls that
// the old enroll-agent.ps1 wrapper used to do. Without trimming, a byte-
// patched template MSI would pass a 512-char right-padded server URL to the
// agent and url.Parse would reject it with "invalid character \" \" in host
// name".
func TestTrimEnrollInputs(t *testing.T) {
	t.Parallel()

	// Mirrors the padding size used by installer/build-msi.ps1 when -Template
	// is set. Keep in sync if that padding width changes.
	const templatePadWidth = 512

	pad := func(s string) string {
		if len(s) >= templatePadWidth {
			return s
		}
		return s + strings.Repeat(" ", templatePadWidth-len(s))
	}

	tests := []struct {
		name                                   string
		inKey, inServer, inSecret              string
		wantKey, wantServer, wantSecret        string
	}{
		{
			name:       "all clean",
			inKey:      "brz_abc123",
			inServer:   "https://app.example.com",
			inSecret:   "secret456",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "empty inputs",
			inKey:      "",
			inServer:   "",
			inSecret:   "",
			wantKey:    "",
			wantServer: "",
			wantSecret: "",
		},
		{
			name:       "whitespace-only inputs collapse to empty",
			inKey:      "   ",
			inServer:   "\t\t",
			inSecret:   " \r\n ",
			wantKey:    "",
			wantServer: "",
			wantSecret: "",
		},
		{
			name:       "trailing space only",
			inKey:      "brz_abc123 ",
			inServer:   "https://app.example.com   ",
			inSecret:   "secret456\n",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "leading whitespace only",
			inKey:      "  brz_abc123",
			inServer:   "\thttps://app.example.com",
			inSecret:   " secret456",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "template MSI 512-char space padding (the regression)",
			inKey:      pad("enroll_b9297caef01ceb804a59af044f5f02aa08605178a06c1833"),
			inServer:   pad("https://us.2breeze.app"),
			inSecret:   pad("41d9a8a62f54c28e12b1055dec82173fd7e073c4c7f2314442da7abbc2c5e68d"),
			wantKey:    "enroll_b9297caef01ceb804a59af044f5f02aa08605178a06c1833",
			wantServer: "https://us.2breeze.app",
			wantSecret: "41d9a8a62f54c28e12b1055dec82173fd7e073c4c7f2314442da7abbc2c5e68d",
		},
		{
			name:       "optional secret left empty after padding trim",
			inKey:      pad("brz_abc123"),
			inServer:   pad("https://app.example.com"),
			inSecret:   strings.Repeat(" ", templatePadWidth),
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			gotKey, gotServer, gotSecret := trimEnrollInputs(tc.inKey, tc.inServer, tc.inSecret)
			if gotKey != tc.wantKey {
				t.Errorf("key: got %q, want %q", gotKey, tc.wantKey)
			}
			if gotServer != tc.wantServer {
				t.Errorf("server: got %q, want %q", gotServer, tc.wantServer)
			}
			if gotSecret != tc.wantSecret {
				t.Errorf("secret: got %q, want %q", gotSecret, tc.wantSecret)
			}
		})
	}
}

// writeEnrolledConfig writes a minimal agent.yaml + secrets.yaml pair
// that config.Load will parse into a config with both AgentID and
// AuthToken set (IsEnrolled returns true).
func writeEnrolledConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// writeTornConfig writes only agent.yaml (with AgentID) but no secrets
// file, simulating the race window where SaveTo has flushed agent.yaml
// but not yet written secrets.yaml.
func writeTornConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

func TestWaitForEnrollment_UnblocksWhenConfigBecomesValid(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "agent.yaml")

	// Start with no config file at all.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Write a valid enrolled config after 50ms.
	time.Sleep(50 * time.Millisecond)
	_ = writeEnrolledConfig(t, dir)

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("waitForEnrollment returned nil; expected enrolled config")
		}
		if cfg.AgentID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
			t.Errorf("AgentID = %q, want aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cfg.AgentID)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 1.5s")
	}
}

func TestWaitForEnrollment_RespectsContextCancel(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "does-not-exist.yaml")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Cancel after 30ms — waitForEnrollment should return nil within
	// another 30ms (next ticker fire).
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case cfg := <-done:
		if cfg != nil {
			t.Errorf("expected nil on ctx cancel, got %+v", cfg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 500ms of cancel")
	}
}

func TestWaitForEnrollment_IgnoresTornWrite(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	// Write only agent.yaml — no secrets file (torn SaveTo state).
	agentPath := writeTornConfig(t, dir)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Verify it stays blocked for 100ms (IsEnrolled returns false on torn state).
	time.Sleep(100 * time.Millisecond)
	select {
	case cfg := <-done:
		t.Fatalf("waitForEnrollment returned %+v on torn write; must stay blocked until secrets.yaml lands", cfg)
	default:
	}

	// Now write secrets.yaml — waitForEnrollment should unblock on the next tick.
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("expected enrolled config, got nil")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("waitForEnrollment did not unblock after secrets.yaml was written")
	}
}
