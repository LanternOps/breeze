package agentapp

import (
	"fmt"
	"os"
	"strings"
)

// serviceStartPlan records whether `service install` must leave the service
// RUNNING when it returns, and the reason to print.
//
// Before #5252 the install command stopped the unit ("safe for upgrades"),
// rewrote it, enabled it — and then returned without ever starting it. On a
// remote, already-enrolled host whose only management path is the agent
// itself, that stranded the box: the device went Offline and stayed Offline
// until somebody reached it over SSH or a console. The watchdog did not save
// it either (see EvaluateStandby).
type serviceStartPlan struct {
	// Start is true when install must (re)start the service before returning.
	Start bool
	// Reason is a short human-readable justification, printed by the caller.
	Reason string
}

// planServiceStart decides whether `service install` starts the service.
//
// Two independent triggers, either of which is sufficient:
//
//   - wasRunning: the unit was active before install stopped it. Install is
//     documented as an upgrade path, and an upgrade must not change whether
//     the service is running.
//   - enrolled: the host already has an agent ID, so the service is meant to
//     be running even if it happened to be down at install time (a crashed or
//     manually-stopped agent being upgraded still wants to come back).
//
// A host that is neither running nor enrolled is a fresh install: there is
// nothing to talk to a server about yet, so the operator enrolls first.
func planServiceStart(wasRunning, enrolled bool) serviceStartPlan {
	switch {
	case wasRunning:
		return serviceStartPlan{Start: true, Reason: "it was running before this install"}
	case enrolled:
		return serviceStartPlan{Start: true, Reason: "this host is already enrolled"}
	default:
		return serviceStartPlan{Start: false, Reason: "this host is not enrolled yet"}
	}
}

// applySystemdUnit runs the systemd tail of `service install`: daemon-reload,
// enable, and — when the plan says so — restart.
//
// `restart` rather than `start` deliberately: it is correct whether or not the
// unit is currently active, so it also covers the case where something else
// (a sibling installer, the watchdog) started the unit between our stop and
// this call, and it guarantees the freshly copied binary is the one running.
//
// Split out of the cobra RunE bodies purely so the argv sequence is assertable
// without root or a live init system — the regression guard for #5252 is
// "a restart is issued at all", which is exactly the kind of omission a
// hand-read of the command misses.
func applySystemdUnit(run commandRunner, serviceName string, plan serviceStartPlan) (started bool, err error) {
	if out, err := run("systemctl", "daemon-reload"); err != nil {
		return false, fmt.Errorf("failed to reload systemd: %s", strings.TrimSpace(string(out)))
	}

	// Enable failures stay warnings: a unit that is installed but not enabled
	// still runs until the next reboot, which is strictly better than aborting
	// the install half-done.
	if out, err := run("systemctl", "enable", serviceName); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to enable service: %s\n", strings.TrimSpace(string(out)))
	}

	if !plan.Start {
		return false, nil
	}

	if out, err := run("systemctl", "restart", serviceName); err != nil {
		return false, fmt.Errorf("failed to start %s after install: %s",
			serviceName, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// applyLaunchdJob is the launchd counterpart of applySystemdUnit: it leaves the
// job RUNNING when the plan says so.
//
// A job that is already loaded is kickstarted with -k, which kills the running
// instance and starts a fresh one — the launchd equivalent of `systemctl
// restart`, and the only way the binary we just copied over the old one
// actually takes over. A job that is not loaded is bootstrapped, falling back
// to the legacy `load` on older macOS.
func applyLaunchdJob(run commandRunner, label, plistPath string, loaded bool, plan serviceStartPlan) (started bool, err error) {
	if !plan.Start {
		return false, nil
	}
	if loaded {
		if out, kickErr := run("launchctl", "kickstart", "-k", "system/"+label); kickErr != nil {
			return false, fmt.Errorf("failed to restart %s after install: %s",
				label, strings.TrimSpace(string(out)))
		}
		return true, nil
	}
	out, bootErr := run("launchctl", "bootstrap", "system", plistPath)
	if bootErr == nil {
		return true, nil
	}
	// Fallback to the legacy loader before giving up.
	out2, loadErr := run("launchctl", "load", plistPath)
	if loadErr != nil {
		return false, fmt.Errorf("failed to start %s after install: %s / %s",
			label, strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
	}
	return true, nil
}
