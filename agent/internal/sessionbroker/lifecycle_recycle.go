package sessionbroker

import (
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Replacing a SYSTEM helper whose process can no longer capture with DXGI
// (#12624).
//
// The budget lives here, in the service, because the helper's own memory does
// not survive the replacement. It need not survive the service: a service
// restart ends every helper (their Job Object closes), so each starts clean.
const (
	helperRecycleLimit  = 3
	helperRecycleWindow = 6 * time.Hour
)

var (
	ErrHelperRecycleUnavailable = errors.New("this helper cannot be replaced by the lifecycle manager")
	ErrHelperRecycleStale       = errors.New("the helper that asked to be replaced is no longer connected")
	ErrHelperRecycleInProgress  = errors.New("this helper is already being replaced")
	ErrHelperRecycleBudget      = errors.New("helper replacement limit reached")
)

// helperRecycleAllowed reports whether a helper replaced at the given times may
// be replaced again now.
func helperRecycleAllowed(history []time.Time, now time.Time) bool {
	return len(recentRecycles(history, now)) < helperRecycleLimit
}

func recentRecycles(history []time.Time, now time.Time) []time.Time {
	recent := make([]time.Time, 0, len(history))
	for _, at := range history {
		if now.Sub(at) < helperRecycleWindow {
			recent = append(recent, at)
		}
	}
	return recent
}

// RecycleHelper replaces the process behind session with a clean helper for
// the same Windows session, immediately rather than on the next reconcile
// tick: a desktop start only waits 10s for a helper to appear.
//
// prepare asks the helper to stop taking work; it returns an error when the
// helper is busy, and then nothing is changed. It runs with no lock held. The
// replacement acts on this exact session: if another helper owns the key by
// then, ErrHelperRecycleStale is returned and that helper is untouched.
func (m *HelperLifecycleManager) RecycleHelper(session *Session, reason string, prepare func() error) error {
	key, ok := helperKeyFromSession(session)
	if !ok || key.Role != ipc.HelperRoleSystem || m.broker == nil || m.spawner == nil {
		return ErrHelperRecycleUnavailable
	}
	if err := m.beginRecycle(key, session, reason); err != nil {
		return err
	}
	defer m.endRecycle(key)

	if err := prepare(); err != nil {
		return err
	}

	// Bind to the process now: after the session closes, the registry may
	// already track a successor.
	entry := m.registry.trackedByPID(key, uint32(session.PID))
	if m.broker.HelperSessionByKey(key) != session {
		return ErrHelperRecycleStale
	}
	owned, killErr := m.broker.terminateHelperKeyOwner(key, session)
	if !owned {
		return ErrHelperRecycleStale
	}
	// Spent once a kill was attempted, whatever its outcome: a helper that
	// cannot be killed must not be tried again and again.
	used := m.noteRecycle(key)
	if err := m.awaitRecycledExit(entry, killErr); err != nil {
		log.Warn("lifecycle: helper that can no longer use DXGI capture could not be replaced",
			"helperKey", key.String(), "pid", session.PID, "reason", reason, "error", err.Error())
		return err
	}
	log.Warn("lifecycle: replacing helper that can no longer use DXGI capture",
		"helperKey", key.String(), "pid", session.PID, "reason", reason,
		"recyclesInWindow", used, "limit", helperRecycleLimit, "window", helperRecycleWindow.String())
	m.spawnKey(key)
	// Whatever kept spawnKey from acting (a spawn already in flight, a process
	// still exiting) is retried by the run loop.
	m.kickReconcile()
	return nil
}

// beginRecycle takes the single-flight slot for key, or says why the helper
// must not be replaced. An exhausted budget is logged once per window.
func (m *HelperLifecycleManager) beginRecycle(key HelperKey, session *Session, reason string) error {
	if m.broker.HelperSessionByKey(key) != session {
		return ErrHelperRecycleStale
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return ErrHelperRecycleUnavailable
	}
	if m.recycling[key] {
		return ErrHelperRecycleInProgress
	}
	now := m.now()
	if !helperRecycleAllowed(m.recycles[key], now) {
		if last, logged := m.recycleRefusalLogged[key]; !logged || now.Sub(last) >= helperRecycleWindow {
			if m.recycleRefusalLogged == nil {
				m.recycleRefusalLogged = make(map[HelperKey]time.Time)
			}
			m.recycleRefusalLogged[key] = now
			log.Warn("lifecycle: helper can no longer use DXGI capture but was already replaced too often; its sessions stay on GDI",
				"helperKey", key.String(), "reason", reason,
				"limit", helperRecycleLimit, "window", helperRecycleWindow.String())
		}
		return fmt.Errorf("%w: %d in %s", ErrHelperRecycleBudget, helperRecycleLimit, helperRecycleWindow)
	}
	if m.recycling == nil {
		m.recycling = make(map[HelperKey]bool)
	}
	m.recycling[key] = true
	return nil
}

func (m *HelperLifecycleManager) endRecycle(key HelperKey) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.recycling, key)
}

// noteRecycle consumes one unit of key's budget and returns how many are used.
func (m *HelperLifecycleManager) noteRecycle(key HelperKey) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if m.recycles == nil {
		m.recycles = make(map[HelperKey][]time.Time)
	}
	m.recycles[key] = append(recentRecycles(m.recycles[key], now), now)
	return len(m.recycles[key])
}

// awaitRecycledExit waits for the terminated process to be reaped, so the
// replacement is not refused as a duplicate, and kills it through the tracked
// handle if the broker's kill did not take. entry is nil for a helper this
// manager did not spawn (a scheduled task): then the broker's kill is all
// there is.
func (m *HelperLifecycleManager) awaitRecycledExit(entry *trackedHelper, killErr error) error {
	if entry == nil {
		return killErr
	}
	if waitDone(entry.done, m.gracePeriod) {
		return nil
	}
	if err := entry.process.Terminate(); err != nil {
		killErr = errors.Join(killErr, err)
	}
	if waitDone(entry.done, m.finalWait) {
		return nil
	}
	if killErr != nil {
		return killErr
	}
	// Terminated but not yet reaped (a thread still inside a driver call).
	// The registry decides from the process's own liveness whether a
	// replacement may start.
	return nil
}
