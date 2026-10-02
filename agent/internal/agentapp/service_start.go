package agentapp

import (
	"errors"
	"fmt"
	"regexp"
	"time"
)

// reclaimStampRe matches the timestamp in the names of the folders a
// take-back creates (<folder>.untrusted-<time>[-n], <folder>.new-<time>), so
// the same refusal on every attempt reads as one reason.
var reclaimStampRe = regexp.MustCompile(`\.(untrusted|new)-[0-9]{8}T[0-9.]+Z(-[0-9]+)?`)

// Retry delays for a config folder the service cannot take back yet: they
// start at configDirRetryFirstDelay and double up to configDirRetryMaxDelay.
const (
	configDirRetryFirstDelay = 5 * time.Second
	configDirRetryMaxDelay   = 2 * time.Minute
)

// configDirRetryAfterFn is time.After; a seam for tests.
var configDirRetryAfterFn = time.After

// prepareServiceStart is what the Windows service runs, after it has
// registered with the service manager, before it reads any config: it takes
// the machine config folder back (reclaimConfigDirFn) and then takes the
// instance guard (which hardens the folder and holds it open, so it must
// come second).
//
// A folder that cannot be taken back yet — another process holds a file in
// it open, or whether an owner is an administrator cannot be looked up
// while the domain is unreachable — does not stop the service. It calls
// markRunning once, so the service manager sees a started service rather
// than a failed start, records the reason durably (the instance-guard
// marker: the Windows Event Log), and retries with a delay that doubles from
// 5 s to at most 2 minutes, until the take-back succeeds or stop is closed.
// A reason is recorded again only when it changes.
//
// It returns the guard and ok=true to go on starting, or ok=false with the
// exit code to stop with (0 for a stop request while waiting).
func prepareServiceStart(startup ProcessStartup, stop <-chan struct{}, markRunning func()) (mainAgentGuard, uint32, bool) {
	delay := configDirRetryFirstDelay
	lastReason := ""
	waited := false
	for {
		err := reclaimConfigDirFn(false)
		if err == nil {
			if waited {
				log.Info("The agent config folder can be used now; starting")
			}
			break
		}
		if reason := reclaimStampRe.ReplaceAllString(err.Error(), ".$1-<time>"); reason != lastReason {
			writeInstanceGuardMarkerFn(startup, fmt.Errorf("agent config folder (the service keeps running and retries): %w", err))
			lastReason = reason
		} else {
			log.Warn("The agent config folder still cannot be used; retrying", "error", err.Error(), "retryIn", delay.String())
		}
		if !waited {
			markRunning()
			waited = true
		}
		select {
		case <-stop:
			return nil, 0, false
		case <-configDirRetryAfterFn(delay):
		}
		if delay *= 2; delay > configDirRetryMaxDelay {
			delay = configDirRetryMaxDelay
		}
	}

	guard, err := acquireMainAgentGuardFn(startup)
	if err != nil {
		writeInstanceGuardMarkerFn(startup, err)
		if errors.Is(err, ErrMainAgentAlreadyRunning) {
			return nil, exitAlreadyRunning, false
		}
		return nil, exitInstanceGuardError, false
	}
	return guard, 0, true
}
