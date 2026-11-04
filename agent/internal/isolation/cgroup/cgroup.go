// Package cgroup splits the Linux agent's systemd unit cgroup in two
// (spec §3.5 Linux, OD14): the agent's own process moves into `<unit>/agent`,
// and every child the agent spawns is placed in `<unit>/children` at clone
// time (procspawn). The nftables isolator permits the control plane only for
// sockets created in `<unit>/agent`, so a script or terminal child never
// inherits the management-plane permit.
//
// The unit must run with Delegate=yes: systemd then leaves the sub-cgroups to
// the agent instead of treating them as its own state.
//
// Import discipline: the recovery binary links the isolation package, which
// links this one. It imports nothing from heartbeat, config or updater.
package cgroup

import "fmt"

// Layout is the agent's split cgroup. Paths are relative to the cgroup v2
// root with no leading slash, the form nft's `socket cgroupv2` expects.
type Layout struct {
	// AgentPath holds the agent process itself (e.g.
	// "system.slice/breeze-agent.service/agent").
	AgentPath string
	// ChildrenPath is where every spawned child is placed before exec.
	ChildrenPath string
	// Level is AgentPath's depth below the root: the `level` operand of
	// `socket cgroupv2 level <n> "<AgentPath>"`.
	Level int
	// ChildrenFD is an O_RDONLY|O_DIRECTORY descriptor of ChildrenPath, the
	// clone3 CLONE_INTO_CGROUP target. The caller owns it.
	ChildrenFD int
}

// Readiness reasons reported in securityCapabilities.networkIsolationUnsupportedReason.
const (
	// ReasonV1 is a cgroup v1 or hybrid host: `socket cgroupv2` cannot match.
	ReasonV1 = "cgroup_v1"
	// ReasonNotDelegated is a unit without Delegate=yes (an install that
	// predates it), or a process not running in its own service unit.
	ReasonNotDelegated = "cgroup_not_delegated"
	// ReasonSpawnUnavailable is a host that cannot place a child with clone3
	// CLONE_INTO_CGROUP (kernel older than 5.7, or a seccomp policy refusing it).
	ReasonSpawnUnavailable = "cgroup_spawn_unavailable"
	// ReasonUnavailable is any other failure to build or verify the split.
	ReasonUnavailable = "cgroup_unavailable"
)

// NotDelegatedMessage is the operator-facing remedy for ReasonNotDelegated.
const NotDelegatedMessage = "agent unit lacks Delegate=yes (reinstall the agent)"

// failureCode mirrors isolation.FailMechanismUnavailable. This package cannot
// import isolation (isolation imports it).
const failureCode = "mechanism_unavailable"

// Error is a refusal to split the cgroup. Every one is an episode
// `mechanism_unavailable`; Reason says which readiness input failed.
type Error struct {
	Reason string
	Detail string
	Err    error
}

func (e *Error) Error() string {
	msg := e.Detail
	if e.Reason == ReasonNotDelegated {
		msg = NotDelegatedMessage + ": " + e.Detail
	}
	if e.Err != nil {
		return fmt.Sprintf("%s (%s): %v", msg, e.Reason, e.Err)
	}
	return fmt.Sprintf("%s (%s)", msg, e.Reason)
}

func (e *Error) Unwrap() error { return e.Err }

// FailureCode is the episode failure code a refusal maps to.
func (e *Error) FailureCode() string { return failureCode }
