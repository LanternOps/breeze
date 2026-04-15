//go:build windows

package sessionbroker

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// HelperLifecycleManager proactively spawns user helpers into eligible Windows
// sessions so remote desktop is available instantly after reboot, without
// waiting for an on-demand desktop_start command.
//
// It receives session-change events pushed by the SCM (SERVICE_CONTROL_SESSIONCHANGE)
// for instant reaction, and runs a slow reconcile tick as a safety net for edge
// cases (missed events during early boot, helper crash detection).
type HelperLifecycleManager struct {
	broker   *Broker
	detector SessionDetector
	scmCh    <-chan SCMSessionEvent
	mu       sync.Mutex
	tracked  map[string]*trackedSession // "winSessionID-role" -> state
}

type trackedSession struct {
	spawnedAt   time.Time
	retryCount  int
	lastFailure time.Time

	// fatalExitUntil suppresses respawns until this time when the helper
	// exited with a fatal exit code (typically 2, meaning permanent auth
	// rejection). Cleared on SCM session change events.
	fatalExitUntil time.Time
}

// SCMSessionEvent is a session-change notification forwarded from the Windows
// Service Control Manager (SERVICE_CONTROL_SESSIONCHANGE).
type SCMSessionEvent struct {
	// EventType is the WTS event constant (e.g. WTS_SESSION_LOGON = 0x5).
	EventType uint32
	// SessionID is the Windows session ID from WTSSESSION_NOTIFICATION.
	SessionID uint32
}

const (
	// initialDelay lets WTS settle after service start / reboot.
	initialDelay = 3 * time.Second

	// reconcileInterval is the safety-net tick. Kept slow because the SCM
	// hook handles the fast path; this only catches helper crashes and
	// edge cases.
	reconcileInterval = 30 * time.Second

	// maxBackoff caps the exponential retry delay.
	maxBackoff = 30 * time.Second

	// maxSpawnRetries stops retrying a session that is permanently broken.
	// Tracking resets when the session disappears and reappears in WTS.
	maxSpawnRetries = 10

	// fatalCooldown is how long a session+role is blocked from respawn
	// after a helper exits with a fatal exit code (2 — permanent auth
	// rejection). Cleared early on SCM session change events.
	fatalCooldown = 10 * time.Minute

	// helperFatalExitCode is the exit code a helper uses to signal
	// permanent rejection. Must match main.go's os.Exit(2).
	helperFatalExitCode = 2

	// helperPanicExitCode is the exit code the helper uses from its
	// top-level panic recovery. Must match main.go's os.Exit(3). Treated
	// as transient — no fatal cooldown.
	helperPanicExitCode = 3

	// WTS event type constants (matching windows.WTS_SESSION_*).
	wtsSessionLogon     = 0x5
	wtsSessionLogoff    = 0x6
	wtsSessionLock      = 0x7
	wtsSessionUnlock    = 0x8
	wtsSessionCreate    = 0xa
	wtsSessionTerminate = 0xb
)

// NewHelperLifecycleManager creates a lifecycle manager driven by SCM session
// events. Pass nil for scmCh to fall back to reconcile-only mode (useful for
// testing or non-service contexts).
func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent) *HelperLifecycleManager {
	return &HelperLifecycleManager{
		broker:   broker,
		detector: NewSessionDetector(),
		scmCh:    scmCh,
		tracked:  make(map[string]*trackedSession),
	}
}

// Start begins the reconciliation loop. It blocks until ctx is cancelled.
func (m *HelperLifecycleManager) Start(ctx context.Context) {
	// Let WTS settle post-reboot before first reconcile.
	select {
	case <-time.After(initialDelay):
	case <-ctx.Done():
		return
	}

	// Initial reconcile catches sessions that appeared before the SCM hook
	// was registered (or during the initial delay).
	m.reconcile()

	ticker := time.NewTicker(reconcileInterval)
	defer ticker.Stop()

	// If no SCM channel was provided, use a nil channel (never receives)
	// and rely solely on the reconcile tick.
	scmCh := m.scmCh
	if scmCh == nil {
		scmCh = make(<-chan SCMSessionEvent)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-scmCh:
			if !ok {
				return
			}
			m.handleSCMEvent(evt)
		case <-ticker.C:
			m.reconcile()
		}
	}
}

// reconcile ensures both SYSTEM and user helpers are running in every eligible session.
func (m *HelperLifecycleManager) reconcile() {
	sessions, err := m.detector.ListSessions()
	if err != nil {
		log.Warn("lifecycle: failed to list sessions", "error", err.Error())
		return
	}

	currentKeys := make(map[string]bool, len(sessions)*2)

	for _, s := range sessions {
		// Skip Session 0 (services) and non-interactive types.
		if s.Session == "0" || s.Type == "services" {
			continue
		}

		// Only target active or connected (lock screen after reboot) sessions.
		if s.State != "active" && s.State != "connected" {
			continue
		}

		// Spawn SYSTEM helper if missing, reset retry tracking when connected.
		systemKey := s.Session + "-system"
		currentKeys[systemKey] = true
		if m.broker.HasHelperForWinSessionRole(s.Session, "system") {
			m.resetTracked(systemKey)
		} else {
			m.spawnWithRetry(s.Session, "system")
		}

		// Spawn user-token helper if missing. Only for active sessions
		// (user is actually logged in); "connected" means lock screen
		// where WTSQueryUserToken may fail.
		userKey := s.Session + "-user"
		currentKeys[userKey] = true
		if m.broker.HasHelperForWinSessionRole(s.Session, "user") {
			m.resetTracked(userKey)
		} else if s.State == "active" {
			m.spawnWithRetry(s.Session, "user")
		}
	}

	// Clean up tracking for sessions that no longer exist.
	m.mu.Lock()
	for key := range m.tracked {
		if !currentKeys[key] {
			delete(m.tracked, key)
		}
	}
	m.mu.Unlock()
}

// handleSCMEvent reacts to a SERVICE_CONTROL_SESSIONCHANGE notification
// pushed from the SCM handler in service_windows.go.
func (m *HelperLifecycleManager) handleSCMEvent(evt SCMSessionEvent) {
	sessionID := fmt.Sprintf("%d", evt.SessionID)

	// Skip Session 0.
	if evt.SessionID == 0 {
		return
	}

	switch evt.EventType {
	case wtsSessionLogon, wtsSessionUnlock, wtsSessionCreate:
		// A session change means the environment changed — worth retrying
		// a previously-fatal helper. Clear the fatal cooldown for both
		// roles in this session.
		m.mu.Lock()
		if ts, ok := m.tracked[sessionID+"-system"]; ok {
			ts.fatalExitUntil = time.Time{}
		}
		if ts, ok := m.tracked[sessionID+"-user"]; ok {
			ts.fatalExitUntil = time.Time{}
		}
		m.mu.Unlock()

		if !m.broker.HasHelperForWinSessionRole(sessionID, "system") {
			m.spawnWithRetry(sessionID, "system")
		}
		if !m.broker.HasHelperForWinSessionRole(sessionID, "user") {
			m.spawnWithRetry(sessionID, "user")
		}
	case wtsSessionLogoff, wtsSessionTerminate:
		m.mu.Lock()
		delete(m.tracked, sessionID+"-system")
		delete(m.tracked, sessionID+"-user")
		m.mu.Unlock()
	}
}

// resetTracked clears retry state for a tracked session. Called when the
// helper is confirmed connected via IPC, proving the spawn succeeded.
func (m *HelperLifecycleManager) resetTracked(trackKey string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ts, ok := m.tracked[trackKey]; ok {
		ts.retryCount = 0
		ts.lastFailure = time.Time{}
	}
}

// spawnWithRetry spawns a helper with the given role into the Windows session,
// respecting exponential backoff and a max retry cap on repeated failures.
func (m *HelperLifecycleManager) spawnWithRetry(winSessionID, role string) {
	trackKey := winSessionID + "-" + role

	m.mu.Lock()
	ts, exists := m.tracked[trackKey]
	if !exists {
		ts = &trackedSession{}
		m.tracked[trackKey] = ts
	}

	// Respect fatal-exit cooldown from a previous helper that exited with
	// exit code 2 (permanent rejection). Cleared on SCM session changes.
	if now := time.Now(); !ts.fatalExitUntil.IsZero() && now.Before(ts.fatalExitUntil) {
		m.mu.Unlock()
		return
	}

	// Give up after too many failures. The tracking entry is cleaned up
	// when the session disappears from WTS, so retries reset naturally
	// if the user logs out and back in.
	if ts.retryCount >= maxSpawnRetries {
		m.mu.Unlock()
		return
	}

	// Check backoff: 2s, 4s, 8s, 16s, 30s cap.
	if ts.retryCount > 0 {
		backoff := time.Duration(1<<uint(ts.retryCount)) * time.Second
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		if time.Since(ts.lastFailure) < backoff {
			m.mu.Unlock()
			return
		}
	}
	m.mu.Unlock()

	sessionNum, err := strconv.ParseUint(winSessionID, 10, 32)
	if err != nil {
		log.Warn("lifecycle: invalid session ID", "winSessionID", winSessionID, "error", err.Error())
		return
	}

	// Kill stale helpers for this specific role before respawning.
	m.broker.KillStaleHelpers(winSessionID + "-" + role)

	// Spawn the appropriate helper type.
	var spawned *SpawnedHelper
	switch role {
	case "user":
		spawned, err = SpawnUserHelperInSession(uint32(sessionNum))
	default:
		spawned, err = SpawnHelperInSession(uint32(sessionNum))
	}

	// Count every spawn attempt toward the retry cap, not just errors.
	// A "successful" CreateProcessAsUser that crashes before connecting to
	// IPC is still a failure from the lifecycle perspective. The counter
	// resets only when the helper actually connects (resetTracked in reconcile)
	// or the session disappears from WTS.
	m.mu.Lock()
	ts.retryCount++
	ts.lastFailure = time.Now()
	m.mu.Unlock()

	if err != nil {
		if ts.retryCount >= maxSpawnRetries {
			log.Error("lifecycle: giving up on session after max retries",
				"winSessionID", winSessionID,
				"role", role,
				"retryCount", ts.retryCount,
			)
		} else {
			log.Warn("lifecycle: failed to spawn helper",
				"winSessionID", winSessionID,
				"role", role,
				"retryCount", ts.retryCount,
				"error", err.Error(),
			)
		}
		return
	}

	m.mu.Lock()
	ts.spawnedAt = time.Now()
	m.mu.Unlock()

	log.Info("proactively spawned helper in session", "winSessionID", winSessionID, "role", role)

	// Start a goroutine to wait on the helper process. When it exits, apply
	// the fatal-cooldown policy if appropriate. SpawnedHelper.Wait() closes
	// the handle on return.
	if spawned != nil {
		go m.watchHelperExit(trackKey, winSessionID, role, spawned)
	}
}

// watchHelperExit blocks on the helper process and, when it exits, sets the
// fatal cooldown on the tracked entry if the helper exited with the fatal
// exit code (2 — permanent rejection).
func (m *HelperLifecycleManager) watchHelperExit(trackKey, winSessionID, role string, spawned *SpawnedHelper) {
	exitCode, err := spawned.Wait()
	if err != nil {
		log.Warn("lifecycle: wait on helper process failed",
			"winSessionID", winSessionID,
			"role", role,
			"pid", spawned.PID,
			"trackKey", trackKey,
			"error", err.Error(),
		)
		return
	}

	if exitCode == helperFatalExitCode {
		m.mu.Lock()
		ts, ok := m.tracked[trackKey]
		if ok {
			ts.fatalExitUntil = time.Now().Add(fatalCooldown)
		}
		m.mu.Unlock()
		log.Warn("lifecycle: helper exited with fatal code, skipping respawn",
			"winSessionID", winSessionID,
			"role", role,
			"pid", spawned.PID,
			"exitCode", exitCode,
			"cooldown", fatalCooldown.String(),
		)
		return
	}

	if exitCode == helperPanicExitCode {
		// Panic, not permanent rejection. No fatal cooldown — the helper
		// caught the panic at the top level, logged the stack trace, and
		// exited with code 3. Respawn normally so the next desk-start can
		// retry; if the panic reproduces the on-disk log and the shipped
		// error will tell us what's broken.
		log.Warn("lifecycle: helper panicked (exit code 3), will respawn",
			"winSessionID", winSessionID,
			"role", role,
			"pid", spawned.PID,
			"exitCode", exitCode,
		)
		return
	}

	log.Debug("lifecycle: helper exited",
		"winSessionID", winSessionID,
		"role", role,
		"pid", spawned.PID,
		"exitCode", exitCode,
	)
}
