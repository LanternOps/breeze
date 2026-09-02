package main

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/userhelper"
)

// Process exit codes. launchd's KeepAlive for this agent is unconditional, so
// these are for humans and log forensics rather than for launchd's respawn
// decision — but they match the Windows helper's codes so the two platforms
// read the same way in support logs.
const (
	exitOK    = 0
	exitFatal = 2
)

// fatalCooldown is how long the process idles after an unretryable rejection
// before exiting.
//
// The LaunchAgent that runs this binary sets KeepAlive=true with
// ThrottleInterval=10 (agent/service/launchd/com.breeze.desktop-helper-user.plist),
// so launchd respawns the helper roughly every 10 seconds after ANY exit,
// whatever the exit code. Exiting immediately on a permanent rejection would
// therefore turn one unfixable problem into a permanent respawn loop — and
// each respawn re-runs the startup capture probe in runDesktopHelper, which
// re-fires the macOS Screen Recording permission dialog at whoever is sitting
// at the Mac (#4194).
//
// Staying alive is what suppresses that: launchd only respawns a job that has
// exited. Holding the slot for the cooldown and then exiting gives the same
// effect the Windows lifecycle manager gets from its permanent-reject
// lockout, while still handing back one fresh attempt afterwards so a
// corrected config or a reinstalled binary is eventually picked up without a
// manual `launchctl kickstart`.
const fatalCooldown = 10 * time.Minute

// cooldownLogInterval is how often the helper restates why it is idle while
// holding off. The helper's stdout/stderr go to /dev/null in the plist, so
// these lines only reach an operator via the on-disk log and the shipper —
// which is exactly why a single line at the start of a ten-minute hold is
// not enough to diagnose from.
const cooldownLogInterval = 2 * time.Minute

// desktopHelperReconnectPolicy tunes the reconnect loop for macOS.
//
// This is deliberately far more eager than the Windows/Linux user-helper's
// 30s floor (internal/userhelper.defaultMinBackoff). The failure this helper
// actually sees in the field is a transient IPC gap — the agent restarting
// and recreating the socket, or a sleep/wake ordering hiccup — which clears
// in seconds. Every second spent disconnected is a second the device reports
// desktopAccess.reason = "helper_not_connected" and the UI greys out Desktop
// Access even though the device is online (#4194). Dialling a unix socket
// that does not exist fails immediately and costs nothing, so a 1s floor
// growing to a 60s ceiling is cheap insurance.
func desktopHelperReconnectPolicy() userhelper.ReconnectPolicy {
	return userhelper.ReconnectPolicy{
		MinBackoff:      1 * time.Second,
		MaxBackoff:      60 * time.Second,
		StableThreshold: 60 * time.Second,
		WarnLimit:       3,
		WarnWindow:      5 * time.Minute,
	}
}

// supervisorRunner is the seam over *userhelper.Supervisor so the exit-code
// and cooldown policy can be tested without a real IPC socket.
type supervisorRunner interface {
	Run(done <-chan struct{}) userhelper.SupervisorResult
}

// waiter sleeps for d, returning false if shutdown was signalled first.
type waiter func(d time.Duration, done <-chan struct{}) bool

// runSupervisedHelper runs the reconnect supervisor to completion and maps
// its outcome to a process exit code, applying the fatal cooldown described
// above. It does not call os.Exit so that it stays testable.
func runSupervisedHelper(sup supervisorRunner, done <-chan struct{}, cooldown time.Duration, wait waiter) int {
	res := sup.Run(done)

	if res.Reason != userhelper.StopFatal {
		if res.Err != nil {
			log.Info("desktop helper stopped after error", "error", res.Err)
		} else {
			log.Info("desktop helper stopped")
		}
		return exitOK
	}

	var permErr *userhelper.PermanentRejectError
	code, reason := "unknown", res.Err.Error()
	if errors.As(res.Err, &permErr) {
		code = permErr.CodeOr("unknown")
		reason = permErr.ReasonOr(res.Err.Error())
	} else if errors.Is(res.Err, userhelper.ErrSIDLookupFailed) {
		code = "sid_lookup_failed"
	}
	log.Error("desktop helper permanently rejected; holding off before exit so launchd does not respawn-loop",
		"code", code, "reason", reason, "cooldown", cooldown.String())

	// Sleep the cooldown in slices rather than one long wait, so the process
	// keeps saying why it is idle. During the hold `launchctl print` reports
	// a live PID and no exit code, which reads as healthy — these lines are
	// the only thing distinguishing "wedged, waiting to exit" from "working".
	// Interrupting the cooldown does not change the classification — the
	// rejection really was fatal — it just stops us from ignoring a SIGTERM
	// for ten minutes during an agent upgrade or uninstall.
	for remaining := cooldown; remaining > 0; {
		step := min(remaining, cooldownLogInterval)
		if !wait(step, done) {
			log.Info("desktop helper fatal cooldown interrupted by shutdown")
			break
		}
		remaining -= step
		if remaining > 0 {
			log.Warn("desktop helper still holding off after a permanent rejection",
				"code", code, "remaining", remaining.String())
		}
	}
	return exitFatal
}
