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

// ipcVetoLimit bounds the D3 in-flight-backup veto (see
// vetoIPCFailureForBackup): after ipcVetoLimit consecutive vetoes, an
// IPC-failure escalation is let through anyway, so an agent that keeps
// reporting an active backup run while its IPC transport is genuinely
// wedged still gets restarted. At the 30s default IPCProbeInterval that is
// 10 minutes.
const ipcVetoLimit = 20

// ipcVetoRecencyMultiplier sizes the state_sync recency window
// vetoIPCFailureForBackup checks against: a state_sync received within this
// many IPC probe intervals is treated as live corroboration that the agent
// (and its reported backup run) are still alive right now. Older than that,
// a wedged IPC transport that has also stopped delivering state_syncs gets
// no special treatment and escalates normally.
const ipcVetoRecencyMultiplier = 3

// defaultIPCProbeInterval sizes the veto recency window
// (ipcVetoRecencyMultiplier * defaultIPCProbeInterval) for a HealthChecker
// that never calls SetIPCProbeInterval. Matches the shipped default in
// config.go so behaviour stays sane even if a call site forgets to wire the
// real configured interval through.
const defaultIPCProbeInterval = 30 * time.Second

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
	// lastSyncedHeartbeat is the freshest LastHeartbeat received from the
	// agent over IPC (state_sync). It corroborates the on-disk agent.state:
	// on endpoints where AV/EDR blocks every agent.state write, the file is
	// missing or frozen while the agent is demonstrably healthy — killing on
	// the file alone is what restart-stormed and stranded a fleet install on
	// 2026-07-24 (#2763). The freshest of (file, sync) wins.
	lastSyncedHeartbeat time.Time

	// ipcProbeInterval sizes the state_sync recency window used by
	// vetoIPCFailureForBackup (D3). Defaults to defaultIPCProbeInterval;
	// override with SetIPCProbeInterval to match the real configured
	// IPCProbeInterval.
	ipcProbeInterval time.Duration
	// ipcVetoCount is the number of consecutive IPC-failure escalations the
	// in-flight-backup veto has absorbed. Bounded by ipcVetoLimit.
	ipcVetoCount int
	// lastIPCVetoed records whether the most recent CheckIPC call vetoed an
	// escalation, so the caller (main.go) can log a distinct journal event
	// for it instead of the ordinary check.ipc_degraded.
	lastIPCVetoed bool
	// activeBackupRuns is the freshest ActiveBackupRuns count reported over
	// IPC (state_sync). See NoteStateSync.
	activeBackupRuns int
	// lastStateSyncAt is the wall-clock time the freshest state_sync was
	// received. Deliberately the RECEIPT time, not the sync's own
	// LastHeartbeat value: the veto is corroborating that the agent's
	// IPC/heartbeat channel is alive right now, not that some past
	// heartbeat was fresh.
	lastStateSyncAt time.Time
}

// NewHealthChecker constructs a HealthChecker.
func NewHealthChecker(process ProcessChecker, ipc IPCProber, staleThreshold time.Duration) *HealthChecker {
	return &HealthChecker{
		process:          process,
		ipc:              ipc,
		staleThreshold:   staleThreshold,
		ipcProbeInterval: defaultIPCProbeInterval,
	}
}

// SetIPCProbeInterval overrides the IPC probe cadence used to size the
// state_sync recency window for the in-flight-backup veto (see
// vetoIPCFailureForBackup). Call sites that never call this keep
// defaultIPCProbeInterval.
func (h *HealthChecker) SetIPCProbeInterval(d time.Duration) {
	h.ipcProbeInterval = d
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
// Three or more consecutive failures → CheckIPCFailed, UNLESS a backup run
// is in flight and a recent state_sync corroborates the agent is alive (D3)
// — see vetoIPCFailureForBackup — in which case the existing degraded
// verdict is returned instead and LastIPCCheckVetoed reports true so the
// caller can journal the veto distinctly.
// A single failure below threshold → CheckIPCDegraded.
// A successful ping resets the counters and returns CheckOK.
func (h *HealthChecker) CheckIPC() string {
	h.lastIPCVetoed = false
	ok, err := h.ipc.Ping()
	if err != nil || !ok {
		h.ipcFailCount++
		if h.ipcFailCount >= ipcFailThreshold {
			if h.vetoIPCFailureForBackup() {
				h.lastIPCVetoed = true
				return CheckIPCDegraded
			}
			return CheckIPCFailed
		}
		return CheckIPCDegraded
	}
	h.ipcFailCount = 0
	h.ipcVetoCount = 0
	return CheckOK
}

// vetoIPCFailureForBackup decides whether a threshold-crossing IPC failure
// should be suppressed because a backup run is in flight and recent
// state_sync evidence corroborates the agent is alive (D3: a 10k-file backup
// on Windows Server 2022 had its IPC ping/pong round trip intermittently
// exceed IPCProbeInterval under load, and there was no in-flight-backup veto
// anywhere in the watchdog, so the escalation killed the backup helper mid-run).
//
// The veto is bounded by ipcVetoLimit so a genuinely wedged agent that keeps
// reporting an active run still gets restarted eventually — this must not
// become a permanent mask the way the stale-heartbeat veto is bounded by
// staleVetoLimit for the same reason.
func (h *HealthChecker) vetoIPCFailureForBackup() bool {
	if h.activeBackupRuns <= 0 || !h.stateSyncRecent() {
		h.ipcVetoCount = 0
		return false
	}
	if h.ipcVetoCount >= ipcVetoLimit {
		h.ipcVetoCount = 0
		return false
	}
	h.ipcVetoCount++
	return true
}

// stateSyncRecent reports whether a state_sync was received within
// ipcVetoRecencyMultiplier * ipcProbeInterval of now.
func (h *HealthChecker) stateSyncRecent() bool {
	if h.lastStateSyncAt.IsZero() {
		return false
	}
	window := h.ipcProbeInterval * ipcVetoRecencyMultiplier
	if window <= 0 {
		return false
	}
	return time.Since(h.lastStateSyncAt) <= window
}

// IPCVetoCount returns the current consecutive IPC-failure veto count (for
// journal diagnostics).
func (h *HealthChecker) IPCVetoCount() int {
	return h.ipcVetoCount
}

// LastIPCCheckVetoed reports whether the most recent CheckIPC call
// suppressed a CheckIPCFailed escalation via vetoIPCFailureForBackup.
func (h *HealthChecker) LastIPCCheckVetoed() bool {
	return h.lastIPCVetoed
}

// NoteStateSync records the agent-reported LastHeartbeat and in-flight
// backup-run count delivered over IPC (state_sync). The agent only sends a
// state_sync after a successful HTTP-200 heartbeat, so this is authoritative
// liveness evidence even when the on-disk agent.state cannot be written.
// Out-of-order or unparsable heartbeat values never regress the stored
// timestamp. activeBackupRuns and the receipt time always overwrite —
// unlike the heartbeat, staleness there isn't meaningful to guard against,
// and vetoIPCFailureForBackup needs the RECEIPT time of the freshest sync,
// not the freshest value ever seen.
func (h *HealthChecker) NoteStateSync(lastHeartbeat time.Time, activeBackupRuns int) {
	if lastHeartbeat.After(h.lastSyncedHeartbeat) {
		h.lastSyncedHeartbeat = lastHeartbeat
	}
	h.activeBackupRuns = activeBackupRuns
	h.lastStateSyncAt = time.Now()
}

// LastKnownHeartbeat returns the freshest heartbeat timestamp known from any
// source: the on-disk agent.state or the IPC state_sync channel. Zero if
// neither has ever produced one.
func (h *HealthChecker) LastKnownHeartbeat(s *state.AgentState) time.Time {
	hb := h.lastSyncedHeartbeat
	if s != nil && s.LastHeartbeat.After(hb) {
		hb = s.LastHeartbeat
	}
	return hb
}

// CheckHeartbeatStaleness returns CheckOK if the freshest known heartbeat
// (on-disk agent.state OR IPC state_sync — see NoteStateSync) is fresh, or if
// no heartbeat has been recorded yet while a state file exists (zero time =
// startup grace). Returns CheckHeartbeatStale when s is nil AND no state_sync
// was ever received, or when the freshest known heartbeat is older than
// staleThreshold. The file must never outvote fresher IPC evidence: a
// missing/frozen agent.state with live state_syncs is a blocked WRITER
// (AV/EDR on ProgramData), not a dead agent.
func (h *HealthChecker) CheckHeartbeatStaleness(s *state.AgentState) string {
	hb := h.LastKnownHeartbeat(s)
	if s == nil && hb.IsZero() {
		return CheckHeartbeatStale
	}
	if hb.IsZero() {
		// Grace period: heartbeat not yet recorded. A restarted agent gets a
		// fresh veto budget too — residual vetoes from before the restart
		// must not fast-track the new process to escalation.
		h.staleVetoCount = 0
		return CheckOK
	}
	if time.Since(hb) > h.staleThreshold {
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
