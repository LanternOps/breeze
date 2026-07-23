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

// staleVetoLimit: the IPC-liveness corroboration vetoes at most
// staleVetoLimit-1 consecutive stale-heartbeat verdicts; the verdict stands
// on the staleVetoLimit-th. The veto exists to absorb transient state-file
// write starvation (Windows sharing violations), not to permanently mask an
// agent whose heartbeat goroutine is wedged while its IPC listener still
// answers pings — that failure is exactly what the staleness check was built
// to catch. The check ticker runs at HeartbeatStaleThreshold (the cadence
// and the staleness threshold are the same knob), so escalation lands
// staleVetoLimit check intervals — with the 3-minute default, ~9-12 minutes —
// after the heartbeat stops.
const staleVetoLimit = 3

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
	staleVetoCount int
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
		// Grace period: heartbeat not yet recorded. A restarted agent gets a
		// fresh veto budget too — residual vetoes from before the restart
		// must not fast-track the new process to escalation.
		h.staleVetoCount = 0
		return CheckOK
	}
	if time.Since(s.LastHeartbeat) > h.staleThreshold {
		return CheckHeartbeatStale
	}
	// A fresh heartbeat re-arms the stale-veto budget.
	h.staleVetoCount = 0
	return CheckOK
}

// ShouldRestartOnStaleHeartbeat decides whether a stale state-file heartbeat
// justifies restarting the agent. A stale file alone is weak evidence: on
// Windows the agent's atomic rename of agent.state can be starved by sharing
// violations while the agent is perfectly healthy, and restarting a live
// agent on that signal is what burned the 24h restart budget and stranded
// prod devices in failover (2026-07-22). When the IPC connection is live and
// the most recent scheduled probe answered, treat the agent as alive and
// veto the restart — a truly dead agent is still caught by the process check
// (seconds) and by IPC probe failures (a few probe intervals).
//
// The veto is bounded: the stale verdict stands on the staleVetoLimit-th
// consecutive stale verdict (after staleVetoLimit-1 vetoes) regardless of
// IPC state, so an agent whose heartbeat goroutine is wedged while its IPC
// listener keeps answering cannot dodge restarts forever. Call only on a
// CheckHeartbeatStale verdict.
func (h *HealthChecker) ShouldRestartOnStaleHeartbeat(ipcConnected bool) bool {
	if !ipcConnected || h.ipcFailCount > 0 {
		h.staleVetoCount = 0
		return true
	}
	h.staleVetoCount++
	if h.staleVetoCount >= staleVetoLimit {
		h.staleVetoCount = 0
		return true
	}
	return false
}

// StaleVetoCount returns the current consecutive stale-veto count (for
// journal diagnostics).
func (h *HealthChecker) StaleVetoCount() int {
	return h.staleVetoCount
}

// StaleHeartbeatDecision is the outcome of a heartbeat-ticker evaluation.
type StaleHeartbeatDecision int

const (
	// HeartbeatOK — heartbeat fresh, in startup grace, or veto absorbed it.
	HeartbeatOK StaleHeartbeatDecision = iota
	// StaleRestart — stale and corroborated (or escalated): fire unhealthy.
	StaleRestart
	// StaleVetoed — stale but IPC says alive: journal only, no restart.
	StaleVetoed
)

// EvaluateStaleHeartbeat is the complete heartbeat-ticker decision:
// staleness check plus the bounded IPC-corroboration veto. The returned
// count is decision context for the journal — for StaleRestart it is the
// number of vetoes consumed BEFORE this verdict (>0 with a live IPC
// connection means a forced escalation past the veto budget, i.e. a
// ping-answering agent whose heartbeat loop is wedged — operators must be
// able to tell that apart from a routine dead-agent restart); for
// StaleVetoed it is the consecutive vetoes so far including this one.
func (h *HealthChecker) EvaluateStaleHeartbeat(s *state.AgentState, ipcConnected bool) (StaleHeartbeatDecision, int) {
	if h.CheckHeartbeatStaleness(s) != CheckHeartbeatStale {
		return HeartbeatOK, 0
	}
	vetoesBefore := h.staleVetoCount
	if h.ShouldRestartOnStaleHeartbeat(ipcConnected) {
		return StaleRestart, vetoesBefore
	}
	return StaleVetoed, h.staleVetoCount
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
