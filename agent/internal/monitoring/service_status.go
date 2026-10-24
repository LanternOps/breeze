package monitoring

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"

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

// exitCodeOf returns err's process exit code: 0 for nil, -1 when err is not
// an exit status.
func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// systemctlCheckResult maps `systemctl is-active <unit>` (trimmed stdout, how
// it ran, and its exit code) to a check result. Tag-free so it runs on every
// CI OS. loadState runs `systemctl show -p LoadState -- <unit>`.
//
// Only systemd itself proving the unit absent (LoadState=not-found) is
// not_found (#6958: a compliance pass reads not_found as "uninstalled"):
//   - systemctl that cannot be run, or that cannot reach systemd (any exit
//     other than 3 "not active" / 4 "no such unit", e.g. 1 in a container not
//     booted with systemd), is an error, not an answer;
//   - `is-active` prints "inactive" for a unit that does not exist on current
//     systemd, so a non-active unit's LoadState decides not_found vs stopped,
//     and an unreadable LoadState is an error.
func systemctlCheckResult(name, status string, isActive execOutcome, isActiveExit int, execDetail string, loadState func() (string, execOutcome)) CheckResult {
	if isActive == execFailed || (isActive == execExitNonZero && isActiveExit != 3 && isActiveExit != 4) {
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
		out, outcome := loadState()
		state := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "LoadState="))
		switch {
		case outcome != execOK || state == "":
			return CheckResult{
				Status:  StatusError,
				Details: map[string]any{"error": fmt.Sprintf("cannot determine whether unit %s exists", name)},
			}
		case state == "not-found":
			return CheckResult{
				Status:  StatusNotFound,
				Details: map[string]any{"error": fmt.Sprintf("unit %s not found", name)},
			}
		}
	}
	return CheckResult{
		Status:  StatusStopped,
		Details: map[string]any{"systemctlStatus": status},
	}
}
