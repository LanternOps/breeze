package monitoring

import (
	"errors"
	"fmt"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// serviceErrorStatus maps a failed svcquery.GetStatus lookup to a check status.
// Only a lookup that proved the service does not exist is not_found; any other
// failure (access denied, SCM unavailable, query error) is an error — the
// service may well exist and be running (#7967).
func serviceErrorStatus(err error) CheckStatus {
	if errors.Is(err, svcquery.ErrServiceNotFound) {
		return StatusNotFound
	}
	return StatusError
}

// execOutcome classifies one run of a helper command (systemctl).
type execOutcome int

const (
	// execOK: the command ran and exited 0.
	execOK execOutcome = iota
	// execExitNonZero: the command ran and answered with a non-zero exit.
	execExitNonZero
	// execFailed: the command could not be asked (missing binary, start
	// failure, or killed by its deadline). Its silence proves nothing.
	execFailed
)

// classifyExec maps a finished command's error. ctxErr is the command
// context's Err(): a deadline kill surfaces as an *exec.ExitError ("signal:
// killed"), which is a failure to ask, not an answer.
func classifyExec(ctxErr, err error) execOutcome {
	if err == nil {
		return execOK
	}
	if ctxErr != nil {
		return execFailed
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return execExitNonZero
	}
	return execFailed
}

// systemctlCheckResult maps `systemctl is-active <unit>` (trimmed stdout and
// how it ran) to a check result. Tag-free so it runs on every CI OS.
//
// Only systemd itself proving the unit absent (`systemctl cat <unit>` exiting
// non-zero) is not_found. systemctl that cannot be run at all is an error:
// older agents said not_found there, and a compliance pass reads not_found as
// "uninstalled" (#6958). `is-active` prints "inactive" for a unit that does
// not exist on current systemd, so an inactive unit is also checked with cat
// before it is reported as stopped.
func systemctlCheckResult(name, status string, isActive execOutcome, execDetail string, unitCat func() execOutcome) CheckResult {
	if isActive == execFailed {
		return CheckResult{
			Status:  StatusError,
			Details: map[string]any{"error": fmt.Sprintf("systemctl unavailable: %s", execDetail)},
		}
	}

	switch status {
	case "active":
		return CheckResult{Status: StatusRunning}
	case "deactivating":
		return CheckResult{Status: StatusStopped}
	case "failed":
		return CheckResult{
			Status:  StatusStopped,
			Details: map[string]any{"systemctlStatus": "failed"},
		}
	}

	if isActive != execOK {
		switch unitCat() {
		case execExitNonZero:
			return CheckResult{
				Status:  StatusNotFound,
				Details: map[string]any{"error": fmt.Sprintf("unit %s not found", name)},
			}
		case execFailed:
			return CheckResult{
				Status:  StatusError,
				Details: map[string]any{"error": fmt.Sprintf("cannot determine whether unit %s exists", name)},
			}
		}
	}
	return CheckResult{
		Status:  StatusStopped,
		Details: map[string]any{"systemctlStatus": status},
	}
}
