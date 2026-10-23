//go:build !windows

package executor

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// pgidPollInterval is how often the escalation ladder re-checks whether the
// process group is gone during the graceful window.
const pgidPollInterval = 100 * time.Millisecond

// startContained starts the process and captures its process group. On Unix the
// process group IS the containment primitive (setProcessGroup asked for one
// with Setpgid), so a captured pgid marks the execution contained.
func startContained(running *runningExecution, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	if afterStartHook != nil {
		afterStartHook(cmd)
	}
	running.attachProcessGroup(capturePgid(cmd))
	return nil
}

// afterStartHook, when non-nil, runs between cmd.Start returning and the pgid
// being attached. Test-only seam: it holds open the window in which os/exec's
// context watchdog (started inside cmd.Start) can already fire cmd.Cancel
// before attachProcessGroup has run (#9815). Always nil in production. It is an
// unsynchronised package var: a test that sets it must not run in parallel with
// anything that calls Execute.
var afterStartHook func(cmd *exec.Cmd)

// capturePgid reads the process group id immediately after Start.
//
// #3525: looking it up at KILL time — the old behaviour — fails once the leader
// has exited (Getpgid returns ESRCH), and the fallback then kills a corpse via
// cmd.Process.Kill() while the surviving children keep running. After SIGTERM
// that is exactly the state we are in.
//
// setProcessGroup asked for Setpgid with Pgid 0, so the child IS its own group
// leader and pgid == pid by construction. Getpgid here is therefore a
// confirmation, not the source of truth: it also returns ESRCH for a script
// that fails instantly, and treating that as "no group" would mark a perfectly
// contained execution uncontained and downgrade every later cancel to
// kill_failed.
func capturePgid(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil && pgid > 0 {
		return pgid
	}
	return cmd.Process.Pid
}

// terminateProcessTree escalates against the whole process tree.
func terminateProcessTree(running *runningExecution, graceSeconds int) error {
	pgid := running.processGroup()
	cmd := running.command()
	if pgid <= 0 {
		// This kill is landing in the window between cmd.Start returning and
		// attachProcessGroup: os/exec starts its context watchdog inside Start,
		// so a cancel (or timeout) really can fire here (#9815). The group
		// already exists — the child joined it before exec, and Start does not
		// return until exec succeeded — so derive it from the command instead
		// of falling back to a leader-only kill that leaves children running.
		pgid = ownProcessGroup(cmd)
		if pgid > 0 {
			running.attachProcessGroup(pgid)
		}
	}
	if pgid <= 0 {
		// No group to signal: there is no started command, or it was not
		// configured to lead its own process group (setProcessGroup always does,
		// so in production this is defensive). The kill below reaches the
		// leader at most, so latch the
		// execution as uncontained; otherwise a later attachProcessGroup would
		// set contained=true and let this very cancel claim `terminated` while
		// group members survived.
		running.markContainmentLost()
	}
	return terminateProcessTreeUnix(pgid, cmd, graceSeconds)
}

// ownProcessGroup returns the process group a started command leads, derived
// without a syscall: setProcessGroup asks for Setpgid with Pgid 0, so the child
// calls setpgid(0, 0) before exec and pgid == pid by construction. It returns 0
// unless the command was configured that way and has a process, so it can
// never name a group the command does not lead.
func ownProcessGroup(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil || cmd.Process.Pid <= 0 {
		return 0
	}
	attr := cmd.SysProcAttr
	if attr == nil || !attr.Setpgid || attr.Pgid != 0 {
		return 0
	}
	return cmd.Process.Pid
}

// terminateProcessTreeUnix escalates SIGTERM -> grace -> SIGKILL against the
// process GROUP, using the pgid captured at Start.
//
// configureRunAs rewrites cmd.Path/cmd.Args to /usr/bin/sudo, so the signal
// lands on sudo's group — but `sudo -n` children inherit the pgid set by
// setProcessGroup, so the group kill still reaches them.
func terminateProcessTreeUnix(pgid int, cmd *exec.Cmd, graceSeconds int) error {
	if pgid <= 0 {
		// No group was ever captured. Fall back to the leader only; the caller
		// already treats this execution as uncontained, so a cancel here can
		// never report `terminated`.
		if cmd == nil || cmd.Process == nil {
			return nil
		}
		return normalizeSignalErr(cmd.Process.Kill())
	}

	if graceSeconds > 0 {
		if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return err
		}
		deadline := time.After(time.Duration(graceSeconds) * time.Second)
		tick := time.NewTicker(pgidPollInterval)
		defer tick.Stop()
		for {
			select {
			case <-deadline:
				return normalizeSignalErr(syscall.Kill(-pgid, syscall.SIGKILL))
			case <-tick.C:
				// ESRCH == the whole group is gone; nothing left to escalate to.
				if err := syscall.Kill(-pgid, 0); errors.Is(err, syscall.ESRCH) {
					return nil
				}
			}
		}
	}

	return normalizeSignalErr(syscall.Kill(-pgid, syscall.SIGKILL))
}

// normalizeSignalErr folds "the process was already gone" into success. Left as
// an error it would be wrapped by os/exec into cmd.Wait's return AND recorded
// as killErr, downgrading a clean kill to kill_failed.
func normalizeSignalErr(err error) error {
	if err == nil || errors.Is(err, syscall.ESRCH) || errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
