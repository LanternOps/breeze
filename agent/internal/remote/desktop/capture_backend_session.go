//go:build unix

package desktop

import (
	"log/slog"
	"sync/atomic"
	"time"
)

// sckSessionPolicy decides whether a capture session may use ScreenCaptureKit
// and records what the session found (#8058). The macOS capturer wires it to
// the real backends and verdict store (capture_darwin.go,
// capture_darwin_backend.go). It carries a `unix` build tag, not `darwin`, so
// the Linux CI job runs its tests with fakes.
type sckSessionPolicy struct {
	store       func() (*sckVerdictStore, error)
	fingerprint func() sckFingerprint
	now         func() time.Time
	// preflight reports, without prompting, whether TCC says this process
	// holds the Screen Recording grant.
	preflight func() bool
	// latch is the in-process fallback for a verdict that could not be saved.
	latch *atomic.Bool
}

// openSessionCapturer opens the capturer for a macOS 14+ user-session capture.
//
// ScreenCaptureKit is skipped when this process latched or a recorded verdict
// still applies. Otherwise ScreenCaptureKit is opened and its first frame
// verified (sckAttempts tries; a refusal is not retried), falling back to
// CoreGraphics — after a capture-phase failure only when preflight reports the
// grant — and the outcome is recorded.
func (p sckSessionPolicy) openSessionCapturer(b macCaptureBackends, sckAttempts int, sckRetryDelay time.Duration) (ScreenCapturer, error) {
	if p.latch.Load() {
		slog.Info("using CoreGraphics capture: ScreenCaptureKit was found unable to capture earlier in this helper process")
		p.warnIfNoGrant()
		return b.openCG()
	}
	if v := p.applicableVerdict(); v != nil {
		slog.Info("using CoreGraphics capture: a recorded verdict says ScreenCaptureKit cannot capture on this host",
			"reason", v.Reason, "recordedAt", v.RecordedAt.Format(time.RFC3339))
		p.warnIfNoGrant()
		return b.openCG()
	}

	capturer, res, err := openCaptureBackends(macUserSessionPlan(b, sckAttempts, sckRetryDelay))
	if err != nil {
		return nil, err
	}
	p.record(res)
	return capturer, nil
}

// warnIfNoGrant flags a session that goes straight to CoreGraphics while
// preflight reports no Screen Recording grant: those frames can be wallpaper
// and menu bar only. A recorded (non-operator) verdict lapses when preflight
// flips, so this mostly fires for an operator pin or the in-process latch.
func (p sckSessionPolicy) warnIfNoGrant() {
	if !p.preflight() {
		slog.Warn("Screen Recording preflight reports no grant; CoreGraphics frames may show only the wallpaper and menu bar " +
			"(on macOS 26 preflight can also report false while the grant is present)")
	}
}

// applicableVerdict returns the recorded verdict when it still applies to
// this host, else nil. Any problem reading it means "no verdict": the session
// then tries ScreenCaptureKit, which is the pre-#8058 behaviour.
func (p sckSessionPolicy) applicableVerdict() *sckVerdict {
	store, err := p.store()
	if err != nil {
		slog.Warn("cannot locate the ScreenCaptureKit verdict; trying ScreenCaptureKit, which may show the macOS consent dialog",
			"error", err.Error())
		return nil
	}
	v, err := store.load()
	if err != nil {
		slog.Warn("ignoring the recorded ScreenCaptureKit verdict; trying ScreenCaptureKit, which may show the macOS consent dialog",
			"path", store.path(), "error", err.Error())
		return nil
	}
	if v == nil {
		return nil
	}
	if why := v.staleReason(p.fingerprint()); why != "" {
		slog.Info("the recorded ScreenCaptureKit verdict no longer applies; trying ScreenCaptureKit",
			"path", store.path(), "reason", v.Reason, "stale", why)
		return nil
	}
	return v
}

// record updates the verdict after a session opened its capturer through the
// ScreenCaptureKit plan.
//   - ScreenCaptureKit produced the frame: a leftover (stale) verdict is
//     removed.
//   - ScreenCaptureKit reached the capture phase and failed, and CoreGraphics
//     then captured: record it ("declined" when the user refused, -3801, else
//     "capture_failed"). If it cannot be written, latch for this process.
//   - A fallback after init failures only is not recorded. Init failures
//     include transient ones (a display reconfiguring on wake) and fall back on
//     every call anyway; recording one would pin a healthy host to the slower
//     CoreGraphics path.
func (p sckSessionPolicy) record(res captureProbeResult) {
	switch {
	case res.backend == captureBackendScreenCaptureKit:
		store, err := p.store()
		if err != nil {
			slog.Warn("cannot locate the ScreenCaptureKit verdict to clear it", "error", err.Error())
			return
		}
		if removed, err := store.clear(); err != nil {
			slog.Warn("could not remove the stale ScreenCaptureKit verdict",
				"path", store.path(), "error", err.Error())
		} else if removed {
			slog.Info("ScreenCaptureKit captured; removed the stale verdict", "path", store.path())
		}

	case res.primaryCaptureFailed:
		reason := sckVerdictReasonCaptureFailed
		if res.primaryPermissionDenied {
			reason = sckVerdictReasonDeclined
		}
		detail := ""
		if res.primaryErr != nil {
			detail = res.primaryErr.Error()
		}
		store, err := p.store()
		if err == nil {
			err = store.save(newSCKVerdict(reason, detail, p.now(), p.fingerprint()))
		}
		if err != nil {
			p.latch.Store(true)
			slog.Warn("ScreenCaptureKit cannot capture on this host but CoreGraphics can; the verdict could not be saved, "+
				"so only this helper process will skip ScreenCaptureKit and the macOS consent dialog may return after a restart",
				"reason", reason, "error", err.Error())
			return
		}
		slog.Warn("ScreenCaptureKit cannot capture on this host but CoreGraphics can; recorded, so later sessions use CoreGraphics "+
			"until the helper binary, the macOS build or the Screen Recording grant changes",
			"reason", reason, "path", store.path())
	}
}

// status reports the recorded verdict.
func (p sckSessionPolicy) status() ScreenCaptureKitVerdictStatus {
	status := ScreenCaptureKitVerdictStatus{Supported: true}
	store, err := p.store()
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Path = store.path()
	v, err := store.load()
	if err != nil {
		status.Error = err.Error()
		return status
	}
	if v == nil {
		return status
	}
	recordedAt := v.RecordedAt
	status.Present = true
	status.Reason = v.Reason
	status.Detail = v.Detail
	status.RecordedAt = &recordedAt
	status.StaleReason = v.staleReason(p.fingerprint())
	status.Applies = status.StaleReason == ""
	return status
}

// reset removes the recorded verdict.
func (p sckSessionPolicy) reset() (path string, removed bool, err error) {
	store, err := p.store()
	if err != nil {
		return "", false, err
	}
	removed, err = store.clear()
	return store.path(), removed, err
}

// pinCoreGraphics records an operator verdict.
func (p sckSessionPolicy) pinCoreGraphics() (path string, err error) {
	store, err := p.store()
	if err != nil {
		return "", err
	}
	v := newSCKVerdict(sckVerdictReasonOperator, "pinned by an operator", p.now(), p.fingerprint())
	return store.path(), store.save(v)
}
