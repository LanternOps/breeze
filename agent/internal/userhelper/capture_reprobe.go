package userhelper

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Capture re-probe (#6105). The macOS desktop helper decides CanCapture with a
// single real capture at connect and, before this, never revisited it: one
// failed probe (a ScreenCaptureKit timeout, a Screen Recording grant that
// lands a minute later) left the device Desktop Unavailable until the helper
// restarted. The broker accepts a later capabilities message and overwrites
// the stored set, so recovering only needs a re-probe and a re-send.

const (
	captureReprobeInitialDelay = 30 * time.Second
	captureReprobeMaxDelay     = 5 * time.Minute
)

// runCaptureReprobe is a seam so Run's goroutine wiring can be replaced in
// tests without real capture probes.
var runCaptureReprobe = runCaptureReprobeLoop

type captureReprobeConfig struct {
	initialDelay time.Duration
	maxDelay     time.Duration
	// after returns a channel that fires once d has elapsed. nil uses a real
	// timer.
	after func(d time.Duration) <-chan time.Time
	// canProbe reports whether probing is allowed right now (not while a live
	// session owns the capturer).
	canProbe func() bool
	// detect computes the capabilities the helper would send now.
	detect func() ipc.Capabilities
	// send delivers capabilities to the broker.
	send func(ipc.Capabilities) error
}

// needsCaptureReprobe reports whether capabilities just sent warrant the
// re-probe loop. Only the macOS desktop helper derives CanCapture from a live
// capture probe; every other helper's value is static for the connection.
func needsCaptureReprobe(goos, binaryKind string, caps ipc.Capabilities) bool {
	return goos == "darwin" && binaryKind == ipc.HelperBinaryDesktopHelper && !caps.CanCapture
}

// runCaptureReprobeLoop re-probes with exponential backoff (initialDelay
// doubling to maxDelay) until a probe reports CanCapture and that
// capabilities message is delivered, or done closes. It never sends a
// CanCapture=false message: the broker already holds that value.
func runCaptureReprobeLoop(done <-chan struct{}, cfg captureReprobeConfig) {
	delay := cfg.initialDelay
	for {
		if !waitOrDone(done, delay, cfg.after) {
			return
		}
		if cfg.canProbe == nil || cfg.canProbe() {
			caps := cfg.detect()
			if caps.CanCapture {
				if err := cfg.send(caps); err != nil {
					log.Warn("capture recovered but re-sending capabilities failed; will retry",
						"error", err.Error())
				} else {
					log.Info("desktop capture recovered after a failed probe; capabilities re-sent",
						"canCapture", true)
					return
				}
			} else {
				log.Debug("desktop capture re-probe still failing", "nextDelay", nextReprobeDelay(delay, cfg.maxDelay))
			}
		}
		delay = nextReprobeDelay(delay, cfg.maxDelay)
	}
}

func nextReprobeDelay(delay, maxDelay time.Duration) time.Duration {
	next := delay * 2
	if next > maxDelay {
		return maxDelay
	}
	return next
}

// waitOrDone waits for d, returning false if done closes first.
func waitOrDone(done <-chan struct{}, d time.Duration, after func(time.Duration) <-chan time.Time) bool {
	select {
	case <-done:
		return false
	default:
	}
	if after != nil {
		select {
		case <-done:
			return false
		case <-after(d):
			return true
		}
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
		return false
	case <-timer.C:
		return true
	}
}
