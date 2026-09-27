package desktop

import (
	"fmt"
	"log/slog"
	"time"
)

// This file carries no build tag on purpose: the Test Agent CI job runs on
// ubuntu-latest, where the `darwin && cgo` capture shims compile out. Keeping
// the probe's backend ordering here is what lets CI cover it (#6105).

// captureProbeBackend is one screen-capture backend the startup probe can try.
type captureProbeBackend struct {
	// name identifies the backend in logs and errors, e.g. "screencapturekit".
	name string
	// open constructs the capturer. An error here is an init-phase failure.
	open func() (ScreenCapturer, error)
}

// captureProbePlan is the ordered set of backends ProbeCaptureAccess tries.
type captureProbePlan struct {
	primary captureProbeBackend
	// primaryAttempts is how many times a capture-phase failure of the
	// primary is attempted in total. Init-phase failures are never retried.
	// Values below 1 are treated as 1.
	primaryAttempts   int
	primaryRetryDelay time.Duration

	// fallback is tried after the primary fails. nil means no fallback.
	fallback *captureProbeBackend

	// allowCaptureFallback gates the fallback when the primary initialised
	// but could not produce a frame. It exists because a CoreGraphics capture
	// without the Screen Recording grant still returns an image (wallpaper and
	// menu bar, no other apps' windows); falling back blindly would turn a
	// missing permission into CanCapture=true. nil means always allowed.
	//
	// An init-phase failure of the primary falls back unconditionally, which
	// is what newPlatformCapturer has always done.
	allowCaptureFallback func() bool

	// onSuccess, when set, is called by ProbeCaptureAccess with the result of
	// a probe that produced a frame.
	onSuccess func(captureProbeResult)
}

// captureProbeResult reports which backend produced the probe frame.
type captureProbeResult struct {
	backend string
	// primaryCaptureFailed is true when the primary initialised but every
	// capture attempt failed and the fallback then produced a frame. The
	// macOS caller uses it to stop routing streaming sessions to a backend
	// that cannot capture on this host.
	primaryCaptureFailed bool
}

// probeCaptureBackends performs a real capture with plan.primary, retrying a
// capture-phase failure, then tries plan.fallback. Every capturer it opens is
// closed before the next one is opened: on macOS an open capturer holds
// darwinCaptureMu, so leaking one would deadlock the fallback.
func probeCaptureBackends(plan captureProbePlan) (captureProbeResult, error) {
	attempts := plan.primaryAttempts
	if attempts < 1 {
		attempts = 1
	}

	var primaryErr error
	initFailed := false
	for i := 0; i < attempts; i++ {
		if i > 0 && plan.primaryRetryDelay > 0 {
			time.Sleep(plan.primaryRetryDelay)
		}
		capturer, err := plan.primary.open()
		if err != nil {
			primaryErr = err
			initFailed = true
			break
		}
		primaryErr = captureOneProbeFrame(capturer)
		if primaryErr == nil {
			if i > 0 {
				slog.Info("capture probe succeeded on retry",
					"backend", plan.primary.name, "attempt", i+1)
			}
			return captureProbeResult{backend: plan.primary.name}, nil
		}
		slog.Warn("capture probe attempt failed",
			"backend", plan.primary.name, "attempt", i+1, "attempts", attempts,
			"error", primaryErr.Error())
	}

	if plan.fallback == nil {
		return captureProbeResult{}, primaryErr
	}

	if !initFailed && plan.allowCaptureFallback != nil && !plan.allowCaptureFallback() {
		return captureProbeResult{}, fmt.Errorf("%s capture failed (%w); %s fallback not attempted: "+
			"Screen Recording preflight did not report a grant, so a fallback frame could be "+
			"missing other apps' windows", plan.primary.name, primaryErr, plan.fallback.name)
	}

	phase := "capture"
	if initFailed {
		phase = "init"
	}
	slog.Warn("capture probe falling back",
		"from", plan.primary.name, "to", plan.fallback.name, "phase", phase,
		"error", primaryErr.Error())

	fallbackCapturer, err := plan.fallback.open()
	if err == nil {
		err = captureOneProbeFrame(fallbackCapturer)
	}
	if err != nil {
		return captureProbeResult{}, fmt.Errorf("%s failed (%w); %s fallback also failed: %w",
			plan.primary.name, primaryErr, plan.fallback.name, err)
	}

	slog.Info("capture probe succeeded on fallback backend",
		"backend", plan.fallback.name, "primary", plan.primary.name, "phase", phase)
	return captureProbeResult{backend: plan.fallback.name, primaryCaptureFailed: !initFailed}, nil
}

// captureOneProbeFrame captures a single frame and always closes capturer.
func captureOneProbeFrame(capturer ScreenCapturer) error {
	defer func() { _ = capturer.Close() }()
	img, err := capturer.Capture()
	if err != nil {
		return err
	}
	if img == nil || img.Rect.Empty() {
		return fmt.Errorf("capture probe returned no frame")
	}
	return nil
}
