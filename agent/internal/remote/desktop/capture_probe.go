package desktop

import (
	"errors"
	"fmt"
	"image"
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

// captureProbePlan is the ordered set of backends a probe (ProbeCapture) or a
// capture session (openCaptureBackends) tries.
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

	// onSuccess, when set, is called by ProbeCapture with the result of a
	// probe that produced a frame.
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
	// primaryPermissionDenied is true when a primary capture attempt failed
	// with ErrPermissionDenied — on macOS, ScreenCaptureKit's
	// SCStreamErrorUserDeclined (-3801), i.e. the user said no (#8058).
	primaryPermissionDenied bool
	// primaryErr is the primary's last error when the fallback produced the
	// frame, for the caller's logs and persisted verdict.
	primaryErr error
	// primaryOpens counts how many times primary.open was called.
	primaryOpens int
}

// probeCaptureBackends performs a real capture with plan.primary, retrying a
// capture-phase failure, then tries plan.fallback. Every capturer it opens is
// closed before it returns: on macOS an open capturer holds darwinCaptureMu,
// so leaking one would deadlock the next capture.
func probeCaptureBackends(plan captureProbePlan) (captureProbeResult, error) {
	capturer, res, err := openCaptureBackends(plan)
	if err != nil {
		return res, err
	}
	_ = capturer.Close()
	return res, nil
}

// openCaptureBackends is probeCaptureBackends for a caller that goes on to use
// the capturer: it returns the capturer that produced the check frame still
// open. Every other capturer it opened is closed before the next one is
// opened (darwinCaptureMu, see above).
//
// A primary capture attempt that fails with ErrPermissionDenied is not
// retried. That is the user's answer, not a transient failure, and on macOS
// asking ScreenCaptureKit again can put the consent dialog back in front of
// the user (#8058).
func openCaptureBackends(plan captureProbePlan) (ScreenCapturer, captureProbeResult, error) {
	attempts := plan.primaryAttempts
	if attempts < 1 {
		attempts = 1
	}

	var res captureProbeResult
	var primaryErr error
	initFailed := false
	for i := 0; i < attempts; i++ {
		if i > 0 && plan.primaryRetryDelay > 0 {
			time.Sleep(plan.primaryRetryDelay)
		}
		res.primaryOpens++
		capturer, err := plan.primary.open()
		if err != nil {
			primaryErr = err
			initFailed = true
			break
		}
		primaryErr = verifyProbeFrame(capturer)
		if primaryErr == nil {
			if i > 0 {
				slog.Info("capture probe succeeded on retry",
					"backend", plan.primary.name, "attempt", i+1)
			}
			res.backend = plan.primary.name
			return capturer, res, nil
		}
		_ = capturer.Close()
		slog.Warn("capture probe attempt failed",
			"backend", plan.primary.name, "attempt", i+1, "attempts", attempts,
			"error", primaryErr.Error())
		if errors.Is(primaryErr, ErrPermissionDenied) {
			res.primaryPermissionDenied = true
			break
		}
	}

	if plan.fallback == nil {
		return nil, res, primaryErr
	}

	if !initFailed && plan.allowCaptureFallback != nil && !plan.allowCaptureFallback() {
		return nil, res, fmt.Errorf("%s capture failed (%w); %s fallback not attempted: "+
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
		if err = verifyProbeFrame(fallbackCapturer); err != nil {
			_ = fallbackCapturer.Close()
		}
	}
	if err != nil {
		return nil, res, fmt.Errorf("%s failed (%w); %s fallback also failed: %w",
			plan.primary.name, primaryErr, plan.fallback.name, err)
	}

	slog.Info("capture probe succeeded on fallback backend",
		"backend", plan.fallback.name, "primary", plan.primary.name, "phase", phase)
	res.backend = plan.fallback.name
	res.primaryCaptureFailed = !initFailed
	res.primaryErr = primaryErr
	return fallbackCapturer, res, nil
}

// verifyProbeFrame captures one frame without closing capturer. It prefers
// CaptureLatest, which does not consume the frame: the SCStream capturer's
// Capture() hands a frame out once, and a session that keeps this capturer
// reads its first frame right after this check.
func verifyProbeFrame(capturer ScreenCapturer) error {
	var img *image.RGBA
	var err error
	if latest, ok := capturer.(LatestFrameProvider); ok {
		img, err = latest.CaptureLatest()
	} else {
		img, err = capturer.Capture()
	}
	if err != nil {
		return err
	}
	if img == nil || img.Rect.Empty() {
		return fmt.Errorf("capture probe returned no frame")
	}
	return nil
}
