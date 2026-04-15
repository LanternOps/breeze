//go:build windows

package sessionbroker

import (
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Priority 4: fatalExitUntil suppression in spawnWithRetry
// ---------------------------------------------------------------------------

// TestSpawnWithRetrySkipsWhenFatalCooldownActive verifies that spawnWithRetry
// does nothing when the tracked session has a fatalExitUntil set to a future
// time. It verifies the suppression by checking that the retryCount in the
// tracked entry remains unchanged after the call.
func TestSpawnWithRetrySkipsWhenFatalCooldownActive(t *testing.T) {
	t.Parallel()

	// Build a minimal broker that can be passed to NewHelperLifecycleManager.
	// We don't start a listener — we just need the struct.
	broker := New(`\\.\pipe\test-lifecycle-fatal-`+t.Name(), nil)
	defer broker.Close()

	m := NewHelperLifecycleManager(broker, nil)

	winSessionID := "7"
	role := "system"
	trackKey := winSessionID + "-" + role

	// Pre-seed the tracked map with a fatalExitUntil in the future.
	future := time.Now().Add(fatalCooldown) // 10 minutes from now
	m.mu.Lock()
	m.tracked[trackKey] = &trackedSession{
		fatalExitUntil: future,
		retryCount:     0,
	}
	m.mu.Unlock()

	// spawnWithRetry should detect the cooldown and return without spawning.
	m.spawnWithRetry(winSessionID, role)

	// Verify: retryCount should still be 0 (no spawn attempt was made).
	// If a spawn was attempted, retryCount would be incremented to 1.
	m.mu.Lock()
	ts := m.tracked[trackKey]
	m.mu.Unlock()

	if ts == nil {
		t.Fatal("tracked entry was unexpectedly deleted")
	}
	if ts.retryCount != 0 {
		t.Errorf("retryCount = %d, want 0 (spawnWithRetry should have returned early due to fatalExitUntil)", ts.retryCount)
	}
	if ts.fatalExitUntil != future {
		t.Error("fatalExitUntil was modified unexpectedly")
	}
}

// TestSpawnWithRetryProceedsWhenFatalCooldownExpired verifies that spawnWithRetry
// proceeds past the cooldown check when fatalExitUntil is in the past.
// We set it 1 nanosecond in the past so that time.Now().Before(ts.fatalExitUntil)
// is false. The spawn attempt will fail (no real session 7 exists on a test machine),
// but the key behavioral assertion is that retryCount is incremented — proving
// the early-return guard was NOT triggered.
func TestSpawnWithRetryProceedsWhenFatalCooldownExpired(t *testing.T) {
	t.Parallel()

	broker := New(`\\.\pipe\test-lifecycle-expired-`+t.Name(), nil)
	defer broker.Close()

	m := NewHelperLifecycleManager(broker, nil)

	winSessionID := "8"
	role := "system"
	trackKey := winSessionID + "-" + role

	// Set fatalExitUntil 1 second in the past — cooldown has expired.
	past := time.Now().Add(-1 * time.Second)
	m.mu.Lock()
	m.tracked[trackKey] = &trackedSession{
		fatalExitUntil: past,
		retryCount:     0,
	}
	m.mu.Unlock()

	// spawnWithRetry should proceed past the cooldown check.
	// The spawn will likely fail (session 8 probably doesn't exist), but that's OK.
	m.spawnWithRetry(winSessionID, role)

	// retryCount incremented → the guard was not triggered.
	m.mu.Lock()
	ts := m.tracked[trackKey]
	m.mu.Unlock()

	if ts == nil {
		t.Fatal("tracked entry was unexpectedly deleted")
	}
	if ts.retryCount == 0 {
		t.Error("retryCount = 0, want > 0 (spawnWithRetry should have proceeded past expired cooldown)")
	}
}

// TestSpawnWithRetryProceedsWhenFatalCooldownZero verifies that spawnWithRetry
// proceeds when fatalExitUntil is zero (never set).
func TestSpawnWithRetryProceedsWhenFatalCooldownZero(t *testing.T) {
	t.Parallel()

	broker := New(`\\.\pipe\test-lifecycle-zero-`+t.Name(), nil)
	defer broker.Close()

	m := NewHelperLifecycleManager(broker, nil)

	winSessionID := "9"
	role := "system"
	trackKey := winSessionID + "-" + role

	// No pre-seed — trackedSession will be created fresh with zero fatalExitUntil.
	m.spawnWithRetry(winSessionID, role)

	m.mu.Lock()
	ts := m.tracked[trackKey]
	m.mu.Unlock()

	if ts == nil {
		t.Fatal("tracked entry was not created")
	}
	// retryCount should be 1 — the spawn attempt was made (may have failed,
	// but the lifecycle counter was incremented).
	if ts.retryCount == 0 {
		t.Error("retryCount = 0, want > 0 (spawnWithRetry should have attempted spawn with zero fatalExitUntil)")
	}
}

// ---------------------------------------------------------------------------
// Priority 5: handleSCMEvent clears fatalExitUntil
// ---------------------------------------------------------------------------

// TestHandleSCMEventClearsFatalCooldown verifies that session-change events that
// indicate the environment changed favorably (logon, unlock, create) clear the
// fatalExitUntil field so a cooling-down helper can try again.
func TestHandleSCMEventClearsFatalCooldown(t *testing.T) {
	t.Parallel()

	clearingEvents := []struct {
		name      string
		eventType uint32
	}{
		{"WTS_SESSION_LOGON", wtsSessionLogon},
		{"WTS_SESSION_UNLOCK", wtsSessionUnlock},
		{"WTS_SESSION_CREATE", wtsSessionCreate},
	}

	for _, evt := range clearingEvents {
		evt := evt
		t.Run(evt.name, func(t *testing.T) {
			t.Parallel()

			broker := New(`\\.\pipe\test-scm-`+evt.name+t.Name(), nil)
			defer broker.Close()

			m := NewHelperLifecycleManager(broker, nil)

			sessionID := uint32(5)
			sessionIDStr := "5"

			// Pre-seed both roles with future fatalExitUntil.
			future := time.Now().Add(fatalCooldown)
			m.mu.Lock()
			m.tracked[sessionIDStr+"-system"] = &trackedSession{fatalExitUntil: future}
			m.tracked[sessionIDStr+"-user"] = &trackedSession{fatalExitUntil: future}
			m.mu.Unlock()

			// Deliver the event.
			m.handleSCMEvent(SCMSessionEvent{
				EventType: evt.eventType,
				SessionID: sessionID,
			})

			// Both roles should now have fatalExitUntil cleared (zero).
			m.mu.Lock()
			tsSystem := m.tracked[sessionIDStr+"-system"]
			tsUser := m.tracked[sessionIDStr+"-user"]
			m.mu.Unlock()

			if tsSystem != nil && !tsSystem.fatalExitUntil.IsZero() {
				t.Errorf("%s: system role fatalExitUntil not cleared, still %v", evt.name, tsSystem.fatalExitUntil)
			}
			if tsUser != nil && !tsUser.fatalExitUntil.IsZero() {
				t.Errorf("%s: user role fatalExitUntil not cleared, still %v", evt.name, tsUser.fatalExitUntil)
			}
		})
	}
}

// TestHandleSCMEventLogoffDeletesTracking verifies that logoff/terminate events
// remove the tracked entries entirely (not just clear fatalExitUntil).
func TestHandleSCMEventLogoffDeletesTracking(t *testing.T) {
	t.Parallel()

	deletingEvents := []struct {
		name      string
		eventType uint32
	}{
		{"WTS_SESSION_LOGOFF", wtsSessionLogoff},
		{"WTS_SESSION_TERMINATE", wtsSessionTerminate},
	}

	for _, evt := range deletingEvents {
		evt := evt
		t.Run(evt.name, func(t *testing.T) {
			t.Parallel()

			broker := New(`\\.\pipe\test-scm-delete-`+evt.name+t.Name(), nil)
			defer broker.Close()

			m := NewHelperLifecycleManager(broker, nil)

			sessionID := uint32(6)
			sessionIDStr := "6"

			m.mu.Lock()
			m.tracked[sessionIDStr+"-system"] = &trackedSession{retryCount: 3}
			m.tracked[sessionIDStr+"-user"] = &trackedSession{retryCount: 2}
			m.mu.Unlock()

			m.handleSCMEvent(SCMSessionEvent{
				EventType: evt.eventType,
				SessionID: sessionID,
			})

			m.mu.Lock()
			_, systemExists := m.tracked[sessionIDStr+"-system"]
			_, userExists := m.tracked[sessionIDStr+"-user"]
			m.mu.Unlock()

			if systemExists {
				t.Errorf("%s: system role tracking entry not deleted", evt.name)
			}
			if userExists {
				t.Errorf("%s: user role tracking entry not deleted", evt.name)
			}
		})
	}
}

// TestHandleSCMEventSkipsSessionZero verifies that session 0 (services) is
// ignored by handleSCMEvent — it should not create any tracked entries.
func TestHandleSCMEventSkipsSessionZero(t *testing.T) {
	t.Parallel()

	broker := New(`\\.\pipe\test-scm-session0-`+t.Name(), nil)
	defer broker.Close()

	m := NewHelperLifecycleManager(broker, nil)

	// Deliver a logon event for session 0.
	m.handleSCMEvent(SCMSessionEvent{
		EventType: wtsSessionLogon,
		SessionID: 0,
	})

	m.mu.Lock()
	_, exists0Sys := m.tracked["0-system"]
	_, exists0User := m.tracked["0-user"]
	total := len(m.tracked)
	m.mu.Unlock()

	if exists0Sys || exists0User {
		t.Error("session 0 should be ignored by handleSCMEvent but tracking entries were created")
	}
	if total != 0 {
		t.Errorf("expected 0 tracked entries after session-0 event, got %d", total)
	}
}

// TestHandleSCMEventLockDoesNotClearCooldown verifies that a lock event (which
// does NOT indicate a favorable environment change) does NOT clear fatalExitUntil.
// Only logon/unlock/create trigger the clear.
func TestHandleSCMEventLockDoesNotClearCooldown(t *testing.T) {
	t.Parallel()

	broker := New(`\\.\pipe\test-scm-lock-`+t.Name(), nil)
	defer broker.Close()

	m := NewHelperLifecycleManager(broker, nil)

	sessionID := uint32(3)
	sessionIDStr := "3"
	future := time.Now().Add(fatalCooldown)

	m.mu.Lock()
	m.tracked[sessionIDStr+"-system"] = &trackedSession{fatalExitUntil: future}
	m.mu.Unlock()

	// Deliver a lock event — this is NOT in the clearing switch cases.
	m.handleSCMEvent(SCMSessionEvent{
		EventType: wtsSessionLock,
		SessionID: sessionID,
	})

	m.mu.Lock()
	ts := m.tracked[sessionIDStr+"-system"]
	m.mu.Unlock()

	// fatalExitUntil should remain set — lock event doesn't clear it.
	if ts != nil && ts.fatalExitUntil.IsZero() {
		t.Error("lock event cleared fatalExitUntil, but only logon/unlock/create should clear it")
	}
}

// ---------------------------------------------------------------------------
// Priority 6: helperFatalExitCode consistency guard
// ---------------------------------------------------------------------------

// TestFatalExitCodeConsistency is a compile-time-ish guard that ensures the
// exit code used by main.go's os.Exit(2) matches the constant recognized by
// lifecycle.go's watchHelperExit goroutine. A drift between these two values
// would silently break the fatal-cooldown mechanism.
func TestFatalExitCodeConsistency(t *testing.T) {
	// The helper in main.go uses os.Exit(2) as the fatal exit signal.
	// The lifecycle manager must recognize that exact value.
	const expectedFatalExitCode = 2
	if helperFatalExitCode != expectedFatalExitCode {
		t.Errorf("helperFatalExitCode = %d; if this is intentional, update main.go os.Exit call to match %d",
			helperFatalExitCode, expectedFatalExitCode)
	}
}

// TestPanicExitCodeConsistency mirrors TestFatalExitCodeConsistency for the
// panic-recovery path added in PR #450. main.go's top-level panic defer uses
// os.Exit(3) to signal "transient panic, respawn normally"; lifecycle.go's
// watchHelperExit branches on this value to skip the permanent-reject
// cooldown. A drift here would silently send every helper panic into the
// 10-minute lockout meant for genuine permanent rejection.
func TestPanicExitCodeConsistency(t *testing.T) {
	const expectedPanicExitCode = 3
	if helperPanicExitCode != expectedPanicExitCode {
		t.Errorf("helperPanicExitCode = %d; if this is intentional, update main.go os.Exit call to match %d",
			helperPanicExitCode, expectedPanicExitCode)
	}
	if helperPanicExitCode == helperFatalExitCode {
		t.Errorf("helperPanicExitCode (%d) must differ from helperFatalExitCode (%d)",
			helperPanicExitCode, helperFatalExitCode)
	}
}
