package desktop

import (
	"log/slog"
	"time"
)

// This file carries no build tag on purpose: the Test Agent CI job runs on
// ubuntu-latest, where the `darwin && cgo` capture shims compile out. Keeping
// the macOS backend policy here is what lets CI assert it (#6105, #8058).

// Backend names used in probe plans, logs and reports.
const (
	captureBackendScreenCaptureKit = "screencapturekit"
	captureBackendCoreGraphics     = "coregraphics"
)

// macCaptureBackends are the macOS 14+ user-session capture backends. They are
// injected so the ScreenCaptureKit call policy can be tested with fakes.
type macCaptureBackends struct {
	openSCK func() (ScreenCapturer, error)
	openCG  func() (ScreenCapturer, error)
	// preflight reports, without prompting, whether TCC says this process
	// holds the Screen Recording grant.
	preflight func() bool
}

// macUserSessionPlan builds the macOS 14+ user-session plan.
//
// sckAttempts == 0 builds the permission-check plan: CoreGraphics only, one
// attempt, no ScreenCaptureKit call at all. On Sequoia a ScreenCaptureKit call
// can raise macOS's own "record this computer's screen and audio" consent
// dialog, and for the bare (non-bundled) helper binary the approval does not
// persist, so a permission check that touched ScreenCaptureKit re-prompted the
// user on every helper start and every check (#8058). The CoreGraphics frame
// carries the same precision as the macOS 12/13 probe: without the Screen
// Recording grant it can be wallpaper and menu bar only. The precise check
// happens when a real session opens its capturer.
//
// sckAttempts > 0 tries ScreenCaptureKit that many times (a refusal is not
// retried, see openCaptureBackends), then CoreGraphics — after a capture-phase
// failure only when preflight reports the grant, because a CoreGraphics
// capture without it still returns an image and would turn a missing
// permission into a working capturer (#6105).
func macUserSessionPlan(b macCaptureBackends, sckAttempts int, sckRetryDelay time.Duration) captureProbePlan {
	cg := captureProbeBackend{name: captureBackendCoreGraphics, open: b.openCG}
	if sckAttempts <= 0 {
		return captureProbePlan{primary: cg, primaryAttempts: 1}
	}
	return captureProbePlan{
		primary:           captureProbeBackend{name: captureBackendScreenCaptureKit, open: b.openSCK},
		primaryAttempts:   sckAttempts,
		primaryRetryDelay: sckRetryDelay,
		fallback:          &cg,
		allowCaptureFallback: func() bool {
			granted := b.preflight()
			if !granted {
				slog.Warn("ScreenCaptureKit capture failed and Screen Recording preflight reports no grant; not falling back to CoreGraphics")
			}
			return granted
		},
	}
}
