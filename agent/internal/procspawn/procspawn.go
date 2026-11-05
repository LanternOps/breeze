// Package procspawn is the one way the agent starts a child process.
//
// On Linux, once network isolation has split the agent's cgroup
// (isolation/cgroup), every child is created directly inside
// `<unit>/children` with clone3 CLONE_INTO_CGROUP: the child never runs a
// single instruction in `<unit>/agent`, whose sockets alone carry the
// management-plane permit (spec §3.5, OD14). Until the split is configured,
// and on every other OS, these functions are exactly their os/exec
// counterparts.
//
// spawn_contract_test.go enforces that every spawn in agent/internal and
// agent/cmd goes through this package or carries
// `//procspawn:exempt <reason>`.
//
// Pitfall: assigning cmd.SysProcAttr after Command replaces the placement.
// Call Prepare again after any such assignment (the contract test checks it).
//
// Placement is decided when the command is built, not when it starts. A
// command built before placement is enabled and started after it runs where
// the agent was when it was built: in the unit cgroup if built before the
// agent moved, which carries no permit.
package procspawn

import (
	"context"
	"os"
	"os/exec"
)

// Command is exec.Command with the child placed in the children cgroup.
func Command(name string, arg ...string) *exec.Cmd {
	return Prepare(exec.Command(name, arg...))
}

// CommandContext is exec.CommandContext with the child placed in the
// children cgroup.
func CommandContext(ctx context.Context, name string, arg ...string) *exec.Cmd {
	return Prepare(exec.CommandContext(ctx, name, arg...))
}

// Prepare places cmd's child in the children cgroup, keeping every other
// SysProcAttr field. It is idempotent and returns cmd.
func Prepare(cmd *exec.Cmd) *exec.Cmd {
	if cmd != nil {
		prepare(cmd)
	}
	return cmd
}

// StartProcess is os.StartProcess with the child placed in the children
// cgroup. attr may be nil.
func StartProcess(name string, argv []string, attr *os.ProcAttr) (*os.Process, error) {
	if attr == nil {
		attr = &os.ProcAttr{}
	}
	prepareAttr(attr)
	return os.StartProcess(name, argv, attr)
}
