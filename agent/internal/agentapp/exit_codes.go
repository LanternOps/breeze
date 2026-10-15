package agentapp

import (
	"errors"
	"fmt"
	"io"

	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// ExitCodeWatchdogDeferred is the `service install --strict-watchdog` exit
// code when the agent installed but the watchdog bootstrap did not (#8621,
// Decision 6 option B). 78 is sysexits' EX_CONFIG: distinct from the generic 1
// a failed agent install returns, so a scripted lane can tell them apart. It
// is a documented contract; do not renumber it.
const ExitCodeWatchdogDeferred = 78

// watchdogInstallMarkerKey prefixes the one machine-readable line `service
// install` prints when the watchdog install was deferred to the running agent.
const watchdogInstallMarkerKey = "BREEZE_WATCHDOG_INSTALL"

// watchdogSelfHealHint ends the per-OS "watchdog bootstrap failed" warning.
const watchdogSelfHealHint = "Once enrolled, the running agent also retries the watchdog install automatically " +
	"when the server offers a watchdog build (not after --no-watchdog, or when auto-update is disabled).\n"

// strictWatchdog is the `service install --strict-watchdog` flag.
var strictWatchdog bool

const strictWatchdogUsage = "Exit with code 78 when the agent installed but the watchdog could not be installed (default: exit 0; the enrolled agent retries the watchdog install itself)"

// ExitCodeError asks the process to exit with Code instead of the generic 1.
// The message carries only a closed error class, never wrapped error text.
type ExitCodeError struct {
	Code int
	Msg  string
}

func (e *ExitCodeError) Error() string { return e.Msg }

// exitCodeFor maps a command error to the process exit code: an
// ExitCodeError's code when it is a non-zero code, otherwise 1. An error path
// never exits 0.
func exitCodeFor(err error) int {
	var ece *ExitCodeError
	if errors.As(err, &ece) && ece.Code != 0 {
		return ece.Code
	}
	return 1
}

// reportWatchdogBootstrap turns the watchdog bootstrap outcome of `service
// install` into its scripted-lane signal. bootstrapErr is nil when the
// watchdog installed, or when the bootstrap was skipped (--no-watchdog, a
// standing opt-out, or the running agent already holding the install lock).
//
// On failure it prints exactly one line to out:
//
//	BREEZE_WATCHDOG_INSTALL=deferred reason=<class>
//
// where <class> is the closed watchdoginstall.ErrorClass (never error text:
// download errors can embed URLs). The default stays exit 0, because the agent
// did install and the enrolled agent retries the watchdog itself; strict
// returns an ExitCodeError{78} for lanes that must fail instead.
func reportWatchdogBootstrap(bootstrapErr error, strict bool, out io.Writer) error {
	if bootstrapErr == nil {
		return nil
	}
	class, _ := watchdoginstall.Classify(bootstrapErr)
	if out != nil {
		_, _ = fmt.Fprintf(out, "%s=deferred reason=%s\n", watchdogInstallMarkerKey, class)
	}
	if !strict {
		return nil
	}
	return &ExitCodeError{
		Code: ExitCodeWatchdogDeferred,
		Msg:  fmt.Sprintf("watchdog install deferred (reason=%s); failing because --strict-watchdog is set", class),
	}
}

// installExitError is the single exit decision of `service install`: the
// agent's own install/start failure always wins (a host whose agent is down
// must never report the watchdog's outcome instead, #5252), then the
// watchdog's strict-mode error, then success.
func installExitError(agentErr, watchdogErr error) error {
	if agentErr != nil {
		return agentErr
	}
	return watchdogErr
}
