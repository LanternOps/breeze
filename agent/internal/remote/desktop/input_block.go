package desktop

// Local-input blocking for admin remote-desktop sessions (issue #966).
//
// When enabled for a session, the agent swallows the LOCAL keyboard and mouse
// input on the target device so the on-site user and the remote operator are
// not fighting for control. The remote operator's injected input (via the
// InputHandler / SendInput path) is unaffected — only physical local input is
// blocked.
//
// Safety is the overriding design constraint here. We must NEVER leave a user
// permanently locked out of their own machine. Three independent release paths
// guarantee that:
//
//  1. Explicit release — the viewer toggles it off, or the session ends
//     (doCleanup() calls GetInputBlockManager().Release()).
//  2. Process-death release — on every supported platform the OS-level block is
//     tied to the agent process/thread. If the agent crashes or is killed
//     (watchdog, OOM, SIGKILL), the OS automatically tears the block down. This
//     is the critical difference from the wallpaper suppressor, which persists
//     in the registry and therefore needs an on-disk recovery file. Input
//     blocking needs no such file because there is no state that survives the
//     process.
//  3. Max-duration watchdog — a belt-and-suspenders timer auto-releases the
//     block after maxBlockDuration even if the controlling logic wedges (e.g.
//     a half-open WebRTC session that never delivers a stop). This bounds the
//     worst case for a still-running agent whose session bookkeeping is stuck.
//
// The manager is reference-counted so overlapping sessions (rare, but possible
// with multi-monitor or reconnect races) compose correctly: the block engages
// on the first Engage() and lifts on the last Release().

import (
	"log/slog"
	"sync"
	"time"
)

// maxBlockDuration bounds how long a local-input block can stay engaged without
// an explicit release. It is a safety net for a wedged-but-alive agent, not the
// normal release path. Chosen generously so it never fires during a legitimate
// long support session, while still guaranteeing eventual recovery.
const maxBlockDuration = 4 * time.Hour

// inputBlockBackend is the platform-specific interface for blocking and
// unblocking local physical input. Implementations live in
// input_block_{windows,darwin,other}.go.
type inputBlockBackend interface {
	// Block engages local-input blocking. Must be idempotent enough that a
	// double-Block is not catastrophic, but the manager guarantees it is only
	// called on the 0->1 refcount transition.
	Block() error
	// Unblock lifts local-input blocking. Must be safe to call even if Block
	// previously failed (best-effort cleanup).
	Unblock() error
	// Supported reports whether this platform/build can actually block local
	// input. When false, Engage() is a no-op that reports unsupported so the
	// viewer can surface an accurate status instead of a false "blocked".
	Supported() bool
}

// InputBlockManager provides refcounted, watchdog-guarded local-input blocking.
type InputBlockManager struct {
	mu       sync.Mutex
	refCount int
	backend  inputBlockBackend
	engaged  bool

	// watchdogStop signals the max-duration safety timer to exit when the block
	// is released through the normal path. Recreated on each 0->1 engage.
	watchdogStop chan struct{}

	// now and maxDuration are injectable for tests.
	now         func() time.Time
	maxDuration time.Duration
}

var (
	inputBlockMgrOnce     sync.Once
	inputBlockMgrInstance *InputBlockManager
)

// GetInputBlockManager returns the package-level singleton InputBlockManager.
func GetInputBlockManager() *InputBlockManager {
	inputBlockMgrOnce.Do(func() {
		inputBlockMgrInstance = &InputBlockManager{
			backend:     newInputBlockBackend(),
			now:         time.Now,
			maxDuration: maxBlockDuration,
		}
	})
	return inputBlockMgrInstance
}

// Supported reports whether local-input blocking is implemented on this platform.
func (m *InputBlockManager) Supported() bool {
	return m.backend.Supported()
}

// IsEngaged reports whether the block is currently engaged.
func (m *InputBlockManager) IsEngaged() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.engaged
}

// Engage requests local-input blocking. Reference-counted: the first caller
// engages the OS-level block and starts the safety watchdog; subsequent callers
// only bump the counter.
//
// Returns (supported, error). supported is false on platforms where blocking is
// not implemented (the call is then a no-op); the viewer uses this to show an
// accurate status. error is non-nil only when blocking IS supported but the
// OS call failed.
func (m *InputBlockManager) Engage() (supported bool, err error) {
	if !m.backend.Supported() {
		return false, nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.refCount++
	if m.refCount > 1 {
		return true, nil // already engaged by an earlier session
	}

	if err := m.backend.Block(); err != nil {
		m.refCount--
		return true, err
	}
	m.engaged = true
	m.watchdogStop = make(chan struct{})
	go m.runWatchdog(m.watchdogStop)

	slog.Info("Local input blocked on target", "maxDuration", m.maxDuration.String())
	return true, nil
}

// Release lifts local-input blocking. Reference-counted: only the final caller
// actually lifts the OS-level block. Idempotent — extra Release calls (e.g. a
// double doCleanup) are safe no-ops once the refcount hits zero.
func (m *InputBlockManager) Release() error {
	if !m.backend.Supported() {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.refCount <= 0 {
		m.refCount = 0
		return nil
	}

	m.refCount--
	if m.refCount > 0 {
		return nil // other sessions still want input blocked
	}

	return m.unblockLocked()
}

// unblockLocked performs the actual OS-level unblock and watchdog teardown.
// Caller must hold m.mu.
func (m *InputBlockManager) unblockLocked() error {
	if !m.engaged {
		return nil
	}
	if m.watchdogStop != nil {
		close(m.watchdogStop)
		m.watchdogStop = nil
	}
	err := m.backend.Unblock()
	m.engaged = false
	if err != nil {
		slog.Warn("Failed to unblock local input", "error", err.Error())
		return err
	}
	slog.Info("Local input unblocked on target")
	return nil
}

// runWatchdog auto-releases the block after maxDuration as a safety net for a
// wedged-but-alive agent. Exits early when stop is closed (normal release).
//
// Refcount-safe overlap handling: the watchdog reclaims exactly ONE reference
// (the wedged session that armed it) rather than unconditionally zeroing the
// refcount. If other sessions still legitimately hold the block, the OS-level
// block stays engaged for them and a fresh watchdog is armed to bound their
// duration too; only when the reclaimed reference was the last one does the
// watchdog perform the actual OS unblock. This prevents a wedged session's
// 4h watchdog from yanking input back from a second session that engaged later
// and is still well within its own window.
func (m *InputBlockManager) runWatchdog(stop chan struct{}) {
	timer := time.NewTimer(m.maxDuration)
	defer timer.Stop()

	select {
	case <-stop:
		return
	case <-timer.C:
		m.mu.Lock()
		defer m.mu.Unlock()
		// Re-check under lock: the normal release path may have raced us and
		// already closed our stop channel just as the timer fired.
		if m.watchdogStop != stop || !m.engaged {
			return
		}
		slog.Warn("Local-input block exceeded max duration, reclaiming one reference for safety",
			"maxDuration", m.maxDuration.String(), "refCount", m.refCount)

		// Reclaim only this wedged engagement's reference.
		if m.refCount > 0 {
			m.refCount--
		}

		if m.refCount > 0 {
			// Other sessions still hold the block — leave it engaged for them but
			// re-arm a fresh watchdog so their duration is bounded as well. The
			// old stop channel is replaced so a later normal release targets the
			// new watchdog, not this expiring one.
			m.watchdogStop = make(chan struct{})
			go m.runWatchdog(m.watchdogStop)
			slog.Warn("Local-input block kept engaged for remaining sessions after watchdog",
				"refCount", m.refCount)
			return
		}

		// Last reference reclaimed — perform the actual OS unblock.
		slog.Warn("Local-input block force-released after max duration", "maxDuration", m.maxDuration.String())
		_ = m.unblockLocked()
	}
}
