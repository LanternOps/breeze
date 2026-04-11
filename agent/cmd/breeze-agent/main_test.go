package main

import (
	"sync"
	"testing"
	"time"
)

// TestHelperWarnLimiterBudget verifies that the first `limit` calls with the
// same message all emit WARN (emit=true, suppressed=0), and that the (limit+1)th
// call does NOT emit a WARN when the info interval has not elapsed.
func TestHelperWarnLimiterBudget(t *testing.T) {
	t.Parallel()

	// limit=3, 5-minute window (matches production default)
	lim := newHelperWarnLimiter(3, 5*time.Minute)
	msg := "connect: connect to /var/run/breeze.sock: connection refused"

	// Calls 1–3 should all emit WARN.
	for i := 1; i <= 3; i++ {
		emit, suppressed := lim.shouldLog(msg)
		if !emit {
			t.Errorf("call %d: expected emit=true, got false", i)
		}
		if suppressed != 0 {
			t.Errorf("call %d: expected suppressed=0, got %d", i, suppressed)
		}
	}

	// Call 4: over budget, info interval has not elapsed → (false, 0).
	// NOTE: suppressedSinceInfo was 0 going in, incremented to 1, then INFO
	// would only fire if lastInfoEmit is zero. But we check: lastInfoEmit is
	// zero on entry here, so the first over-budget call WILL return (false, N>0).
	// Actually, re-reading the code: on call 4, suppressed++ → suppressed=1,
	// suppressedSinceInfo++ → 1. lastInfoEmit.IsZero() is true, so it returns
	// (false, 1) and resets suppressedSinceInfo to 0. This matches the
	// "INFO fires immediately at first suppression" behavior.
	emit4, sup4 := lim.shouldLog(msg)
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

	// Exhaust warn budget (3 warns + 1 INFO-emitting call).
	for i := 0; i < 3; i++ {
		lim.shouldLog(msg) //nolint: calls 1-3
	}
	lim.shouldLog(msg) // call 4: first INFO fires, resets suppressedSinceInfo

	// Call 5: within info interval → (false, 0).
	emit, sup := lim.shouldLog(msg)
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
	// Not parallel: uses time.Sleep for infoInterval simulation.
	// Use a very short infoInterval-equivalent by sleeping just past 60s would
	// be impractical; instead we verify the counter reset by examining state.
	//
	// Strategy: exhaust the warn budget (call 1-3), trigger first INFO (call 4),
	// add more suppressions (calls 5-N), then trigger second INFO after sleeping
	// 1ms past infoInterval by replacing the limiter's lastInfoEmit via the
	// public interface — not possible since it's unexported.
	//
	// We instead test the logic structurally: after first INFO (suppressedSinceInfo
	// reset to 0), further calls accumulate a new suppressedSinceInfo. When
	// infoInterval elapses (tested with real sleep), the second INFO should
	// report only the count since the first INFO.
	//
	// Because infoInterval=60s is too long for a test, we verify the counting
	// logic is correct by using the fact that the very first INFO fires
	// immediately (lastInfoEmit.IsZero()). We then check the second INFO
	// would carry the right count using a short sleep that would exceed a
	// tiny infoInterval — but infoInterval is a package constant at 60s, so
	// instead we verify the reset behavior: after the first INFO, subsequent
	// suppressed calls accumulate in suppressedSinceInfo independently.
	//
	// Practical: we confirm that suppressedSinceInfo resets between INFO
	// emissions by running two suppress-then-INFO cycles back-to-back,
	// using a sleep that exceeds infoInterval.

	if testing.Short() {
		t.Skip("skipped in -short mode (requires 61s sleep)")
	}

	lim := newHelperWarnLimiter(1, 10*time.Minute) // limit=1 so budget exhausts at call 2
	msg := "persistent error"

	// Call 1: first warn (under budget).
	lim.shouldLog(msg)

	// Call 2: over budget, first INFO fires immediately (lastInfoEmit was zero).
	_, sup1 := lim.shouldLog(msg)
	if sup1 != 1 {
		t.Fatalf("first INFO: expected suppressed=1, got %d", sup1)
	}

	// Calls 3-5: accumulate 3 more suppressions.
	lim.shouldLog(msg)
	lim.shouldLog(msg)
	lim.shouldLog(msg)

	// Sleep past infoInterval (60s) so the next call triggers a second INFO.
	t.Log("sleeping 61s for infoInterval…")
	time.Sleep(61 * time.Second)

	// Call 6: second INFO should report 3 (calls 3-5 since last INFO).
	_, sup2 := lim.shouldLog(msg)
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

	// Exhaust budget for msgA (2 warns).
	for i := 0; i < 2; i++ {
		lim.shouldLog(msgA)
	}

	// Next msgA call is over budget for A.
	emitA, _ := lim.shouldLog(msgA)
	if emitA {
		t.Errorf("msgA call 3: expected emit=false (over budget), got true")
	}

	// msgB is a new message — it gets its own fresh budget.
	// Window rolls over when msg changes, so call 1 of msgB should emit.
	emitB, supB := lim.shouldLog(msgB)
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
	// Not parallel: uses time.Sleep.
	if testing.Short() {
		t.Skip("skipped in -short mode (requires sleep past window)")
	}

	// Use a 100ms window for fast testing.
	lim := newHelperWarnLimiter(2, 100*time.Millisecond)
	msg := "some persistent error"

	// Exhaust budget.
	lim.shouldLog(msg)
	lim.shouldLog(msg)

	// Over budget.
	emit3, _ := lim.shouldLog(msg)
	if emit3 {
		t.Errorf("call 3: expected emit=false (over budget), got true")
	}

	// Sleep past the 100ms window.
	time.Sleep(150 * time.Millisecond)

	// Window rolled over → fresh budget, should emit again.
	emit4, sup4 := lim.shouldLog(msg)
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

	// Exhaust budget.
	lim.shouldLog(msg)
	lim.shouldLog(msg)
	emit3, _ := lim.shouldLog(msg)
	if emit3 {
		t.Errorf("pre-reset call 3: expected emit=false (over budget)")
	}

	// Reset clears all state.
	lim.reset()

	// Next call should behave as first call ever.
	emit1, sup1 := lim.shouldLog(msg)
	if !emit1 {
		t.Errorf("post-reset call 1: expected emit=true, got false")
	}
	if sup1 != 0 {
		t.Errorf("post-reset call 1: expected suppressed=0, got %d", sup1)
	}

	// Second call should also emit (still within budget of 2).
	emit2, sup2 := lim.shouldLog(msg)
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
				lim.shouldLog(msg)
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
			lim.shouldLog(msg)
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
