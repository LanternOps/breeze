package watchdog

import (
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// Check result constants.
const (
	CheckOK             = "ok"
	CheckProcessGone    = "process_gone"
	CheckIPCDegraded    = "ipc_degraded"
	CheckIPCFailed      = "ipc_failed"
	CheckHeartbeatStale = "heartbeat_stale"
)

const ipcFailThreshold = 3

// ProcessChecker abstracts OS-level process liveness queries.
type ProcessChecker interface {
	IsAlive(pid int) bool
	IsZombie(pid int) bool
}

// IPCProber abstracts IPC health probing.
type IPCProber interface {
	Ping() (bool, error)
}

// HealthChecker runs the three-tier health check suite.
type HealthChecker struct {
	process        ProcessChecker
	ipc            IPCProber
	staleThreshold time.Duration
	ipcFailCount   int
}

// NewHealthChecker constructs a HealthChecker.
func NewHealthChecker(process ProcessChecker, ipc IPCProber, staleThreshold time.Duration) *HealthChecker {
	return &HealthChecker{
		process:        process,
		ipc:            ipc,
		staleThreshold: staleThreshold,
	}
}

// CheckProcess returns CheckOK if the process is alive and not a zombie,
// otherwise CheckProcessGone.
func (h *HealthChecker) CheckProcess(pid int) string {
	if !h.process.IsAlive(pid) || h.process.IsZombie(pid) {
		return CheckProcessGone
	}
	return CheckOK
}

// CheckIPC pings the IPC endpoint and tracks consecutive failures.
// Three or more consecutive failures → CheckIPCFailed.
// A single failure below threshold → CheckIPCDegraded.
// A successful ping resets the counter and returns CheckOK.
func (h *HealthChecker) CheckIPC() string {
	ok, err := h.ipc.Ping()
	if err != nil || !ok {
		h.ipcFailCount++
		if h.ipcFailCount >= ipcFailThreshold {
			return CheckIPCFailed
		}
		return CheckIPCDegraded
	}
	h.ipcFailCount = 0
	return CheckOK
}

// CheckHeartbeatStaleness returns CheckOK if the heartbeat is fresh or has
// never been set (zero time = grace period). Returns CheckHeartbeatStale if s
// is nil or the heartbeat is older than staleThreshold.
func (h *HealthChecker) CheckHeartbeatStaleness(s *state.AgentState) string {
	if s == nil {
		return CheckHeartbeatStale
	}
	if s.LastHeartbeat.IsZero() {
		// Grace period: heartbeat not yet recorded.
		return CheckOK
	}
	if time.Since(s.LastHeartbeat) > h.staleThreshold {
		return CheckHeartbeatStale
	}
	return CheckOK
}

// IPCFailCount returns the current consecutive IPC failure count.
func (h *HealthChecker) IPCFailCount() int {
	return h.ipcFailCount
}

// ResetIPCFails resets the consecutive IPC failure counter to zero.
func (h *HealthChecker) ResetIPCFails() {
	h.ipcFailCount = 0
}

// OSProcessChecker is the real OS-backed implementation of ProcessChecker.
type OSProcessChecker struct{}
