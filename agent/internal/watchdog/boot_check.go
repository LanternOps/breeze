package watchdog

import (
	"strconv"
	"strings"
	"time"
)

// AgentServiceState is what the OS service manager (SCM, systemd, launchd)
// reports for the agent's service right now.
type AgentServiceState string

const (
	// AgentServiceUnknown: the service manager could not be asked, or gave an
	// answer this file does not map. Callers fall back to process evidence.
	AgentServiceUnknown  AgentServiceState = "unknown"
	AgentServiceRunning  AgentServiceState = "running"
	AgentServiceStarting AgentServiceState = "starting"
	AgentServiceStopped  AgentServiceState = "stopped"
)

// AgentServiceStatus is one service-manager observation of the agent service.
// PID is the process the service manager names; 0 when it names none.
type AgentServiceStatus struct {
	State AgentServiceState
	PID   int
	// Detail is the raw state or the query error, for the journal only.
	Detail string
}

// BootDecision is the outcome of one boot check (EvaluateBootCheck).
type BootDecision int

const (
	// BootHold: the service manager says the agent is running or starting.
	// Wait for IPC; do not recover.
	BootHold BootDecision = iota
	// BootNotFound: the agent is not running. Hand off to the recovery ladder.
	BootNotFound
	// BootRelease: stop the boot check and let the ordinary process, IPC and
	// heartbeat checks decide.
	BootRelease
)

func (d BootDecision) String() string {
	switch d {
	case BootHold:
		return "hold"
	case BootNotFound:
		return "not_found"
	case BootRelease:
		return "release"
	default:
		return "unknown"
	}
}

// BootCheckInput is the evidence for one boot check. Every field must be
// gathered in the same tick the decision is acted on.
type BootCheckInput struct {
	Service AgentServiceStatus
	// StatePID is the freshest PID in agent.state (0 = none). After a reboot
	// it can be the PID of the previous boot's agent, which an unrelated
	// process may now own, so it is only consulted when the service manager
	// gave no answer.
	StatePID      int
	StatePIDAlive bool
	// AgentAlive is HealthChecker.AgentAlive: fresh heartbeat-loop evidence.
	AgentAlive bool
	// Elapsed since the boot check started; Deadline bounds the hold.
	Elapsed  time.Duration
	Deadline time.Duration
}

// EvaluateBootCheck decides what the watchdog does about an agent it could not
// reach over IPC when the watchdog started (#12291).
//
// At boot both services start together, so the watchdog usually reads
// agent.state before the new agent has rewritten it: the PID there belongs to
// the previous boot. Judging that PID dead and restarting the agent spent one
// recovery attempt from the 24h budget on every boot, against an agent that
// was already running. The service manager is the authority on whether the
// agent is up: running or starting means wait for IPC, stopped means recover.
// The state-file PID is consulted only when the service manager gave no
// answer, and then exactly as before this check existed.
//
// The hold is bounded by Deadline. Past it, an agent with fresh heartbeat-loop
// evidence is left to the ordinary checks; anything else is recovered, so an
// agent that wedged during startup is not held forever.
func EvaluateBootCheck(in BootCheckInput) BootDecision {
	if in.Elapsed >= in.Deadline {
		if in.AgentAlive {
			return BootRelease
		}
		return BootNotFound
	}
	switch in.Service.State {
	case AgentServiceRunning, AgentServiceStarting:
		return BootHold
	case AgentServiceStopped:
		return BootNotFound
	}
	if in.StatePID > 0 && in.StatePIDAlive {
		return BootRelease
	}
	return BootNotFound
}

// agentServiceStatusFromSnapshot maps an SCM observation (see
// recovery_windows_logic.go). STOP_PENDING, PAUSE_PENDING and PAUSED are not a
// firm "up" or "down" answer, so they read as unknown.
func agentServiceStatusFromSnapshot(snap serviceSnapshot) AgentServiceStatus {
	status := AgentServiceStatus{State: AgentServiceUnknown, PID: snap.PID, Detail: string(snap.State)}
	switch snap.State {
	case serviceRunning:
		status.State = AgentServiceRunning
	case serviceStartPending, serviceContinuePending:
		status.State = AgentServiceStarting
	case serviceStopped:
		status.State = AgentServiceStopped
	}
	return status
}

// parseSystemctlShow maps `systemctl show --property=LoadState
// --property=ActiveState --property=MainPID <unit>` output.
func parseSystemctlShow(output string) AgentServiceStatus {
	props := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			props[key] = value
		}
	}
	active := props["ActiveState"]
	pid, _ := strconv.Atoi(props["MainPID"])
	if pid < 0 {
		pid = 0
	}
	status := AgentServiceStatus{State: AgentServiceUnknown, PID: pid, Detail: active}
	if props["LoadState"] == "not-found" {
		status.Detail = "not-found"
		return status
	}
	switch active {
	case "active", "reloading":
		status.State = AgentServiceRunning
	case "activating":
		// Includes SubState=auto-restart: systemd is already bringing the
		// unit back on its own.
		status.State = AgentServiceStarting
	case "inactive", "failed":
		status.State = AgentServiceStopped
	}
	return status
}

// parseLaunchctlPrint maps `launchctl print system/<label>` output. Only the
// job's own top-level "state" and "pid" lines count; nested blocks carry
// state lines of their own.
func parseLaunchctlPrint(output string) AgentServiceStatus {
	status := AgentServiceStatus{State: AgentServiceUnknown}
	depth := 0
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if depth == 1 {
			if key, value, ok := strings.Cut(trimmed, " = "); ok {
				switch key {
				case "state":
					status.Detail = value
				case "pid":
					if pid, err := strconv.Atoi(value); err == nil && pid > 0 {
						status.PID = pid
					}
				}
			}
		}
		depth += strings.Count(trimmed, "{") - strings.Count(trimmed, "}")
	}
	switch status.Detail {
	case "running":
		status.State = AgentServiceRunning
	case "spawn scheduled":
		status.State = AgentServiceStarting
	case "not running":
		status.State = AgentServiceStopped
	}
	return status
}
