//go:build darwin && cgo

package desktop

import (
	"errors"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"time"
)

// Wiring for the persisted ScreenCaptureKit verdict (#8058); the store itself
// is capture_backend_verdict.go.

// Seams for tests: the verdict store, the host fingerprint and the clock.
var (
	sckVerdictStoreFn = defaultSCKVerdictStore
	sckFingerprintFn  = currentSCKFingerprint
	sckVerdictNow     = time.Now
)

// defaultSCKVerdictStore is the store for the account this process runs as:
// the console user for the user-session desktop helper. The home directory
// comes from the account database, not $HOME.
func defaultSCKVerdictStore() (*sckVerdictStore, error) {
	cu, err := user.Current()
	if err != nil {
		return nil, err
	}
	if cu.HomeDir == "" {
		return nil, errors.New("the current account has no home directory")
	}
	return &sckVerdictStore{
		dir: filepath.Join(cu.HomeDir, "Library", "Application Support", "Breeze"),
		uid: os.Getuid(),
	}, nil
}

// currentSCKFingerprint describes the host as a verdict depends on it.
// Unreadable parts are left empty, which makes a recorded verdict stale
// rather than wrongly current.
func currentSCKFingerprint() sckFingerprint {
	fp := sckFingerprint{ScreenRecordingPreflight: screenRecordingPreflight()}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		fp.HelperPath = exe
		if info, err := os.Stat(exe); err == nil {
			fp.HelperSize = info.Size()
			fp.HelperModTime = info.ModTime().UnixNano()
		}
	}
	if build, err := syscall.Sysctl("kern.osversion"); err == nil {
		fp.OSBuild = build
	}
	return fp
}

// applicableSCKVerdict returns the recorded verdict when it still applies to
// this host, else nil. Any problem reading it means "no verdict": the session
// then tries ScreenCaptureKit, which is the pre-#8058 behaviour.
func applicableSCKVerdict() *sckVerdict {
	store, err := sckVerdictStoreFn()
	if err != nil {
		slog.Warn("cannot locate the ScreenCaptureKit verdict; trying ScreenCaptureKit",
			"error", err.Error())
		return nil
	}
	v, err := store.load()
	if err != nil {
		slog.Warn("ignoring the recorded ScreenCaptureKit verdict; trying ScreenCaptureKit",
			"path", store.path(), "error", err.Error())
		return nil
	}
	if v == nil {
		return nil
	}
	if why := v.staleReason(sckFingerprintFn()); why != "" {
		slog.Info("the recorded ScreenCaptureKit verdict no longer applies; trying ScreenCaptureKit",
			"path", store.path(), "reason", v.Reason, "stale", why)
		return nil
	}
	return v
}

// recordSCKOutcome updates the verdict after a capture session opened its
// capturer through the ScreenCaptureKit plan.
//   - ScreenCaptureKit produced the frame: a leftover (stale) verdict is
//     removed.
//   - ScreenCaptureKit initialised but could not capture, and CoreGraphics
//     could: record it ("declined" when the user refused, -3801, else
//     "capture_failed"). If it cannot be written, latch for this process.
//   - An init-phase fallback is not recorded. Init failures include transient
//     ones (display reconfiguring on wake) and fall back on every call anyway;
//     persisting one would pin a healthy host to the slower CoreGraphics path.
func recordSCKOutcome(res captureProbeResult) {
	switch {
	case res.backend == captureBackendScreenCaptureKit:
		store, err := sckVerdictStoreFn()
		if err != nil {
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
		store, err := sckVerdictStoreFn()
		if err == nil {
			err = store.save(newSCKVerdict(reason, detail, sckVerdictNow(), sckFingerprintFn()))
		}
		if err != nil {
			sckCaptureUnhealthy.Store(true)
			slog.Warn("ScreenCaptureKit cannot capture on this host but CoreGraphics can; the verdict could not be saved, so only this helper process will skip ScreenCaptureKit",
				"reason", reason, "error", err.Error(), "darwinVersion", macOSMajorVersion)
			return
		}
		slog.Warn("ScreenCaptureKit cannot capture on this host but CoreGraphics can; recorded, so later sessions use CoreGraphics until the helper binary, the macOS build or the Screen Recording grant changes",
			"reason", reason, "path", store.path(), "darwinVersion", macOSMajorVersion)
	}
}

// ScreenCaptureKitVerdict reports the recorded verdict for the account this
// process runs as.
func ScreenCaptureKitVerdict() ScreenCaptureKitVerdictStatus {
	status := ScreenCaptureKitVerdictStatus{Supported: true}
	store, err := sckVerdictStoreFn()
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
	status.StaleReason = v.staleReason(sckFingerprintFn())
	status.Applies = status.StaleReason == ""
	return status
}

// ResetScreenCaptureKitVerdict removes the recorded verdict, so the next
// capture session tries ScreenCaptureKit again. A helper process that latched
// in memory (the verdict could not be saved) keeps CoreGraphics until it
// restarts.
func ResetScreenCaptureKitVerdict() (path string, removed bool, err error) {
	store, err := sckVerdictStoreFn()
	if err != nil {
		return "", false, err
	}
	removed, err = store.clear()
	return store.path(), removed, err
}

// PinCoreGraphicsCapture records an operator verdict: capture sessions for
// this account use CoreGraphics and never call ScreenCaptureKit, across
// upgrades and permission changes, until ResetScreenCaptureKitVerdict.
func PinCoreGraphicsCapture() (path string, err error) {
	store, err := sckVerdictStoreFn()
	if err != nil {
		return "", err
	}
	v := newSCKVerdict(sckVerdictReasonOperator, "pinned by an operator", sckVerdictNow(), sckFingerprintFn())
	return store.path(), store.save(v)
}
