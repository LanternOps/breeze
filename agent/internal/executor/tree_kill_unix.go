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
	running.attachProcessGroup(capturePgid(cmd))
	return nil
}

// capturePgid reads the process group id immediately after Start.
//
// #3525: looking it up at kill time — the old behaviour — fails once the leader
// has exited (Getpgid returns ESRCH), and the fallback then kills a corpse via
// cmd.Process.Kill() while the surviving children keep running. After SIGTERM
// that is exactly the state we are in.
func capturePgid(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		log.Warn("could not capture process group at start; cancellation will not reach children",
			"pid", cmd.Process.Pid, "error", err.Error())
		return 0
	}
	return pgid
}

// terminateProcessTree escalates against the whole process tree.
func terminateProcessTree(running *runningExecution, graceSeconds int) error {
	return terminateProcessTreeUnix(running.processGroup(), running.command(), graceSeconds)
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
