//go:build darwin && cgo

package desktop

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"time"
)

// Wiring for the persisted ScreenCaptureKit verdict (#8058); the store itself
// is capture_backend_verdict.go.

// sckPolicy is the live ScreenCaptureKit session policy
// (capture_backend_session.go). Tests replace it wholesale.
var sckPolicy = sckSessionPolicy{
	store:       defaultSCKVerdictStore,
	fingerprint: currentSCKFingerprint,
	now:         time.Now,
	preflight:   func() bool { return screenRecordingPreflight() },
	latch:       &sckCaptureUnhealthy,
}

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

// ScreenCaptureKitVerdict reports the recorded verdict for the account this
// process runs as.
func ScreenCaptureKitVerdict() ScreenCaptureKitVerdictStatus { return sckPolicy.status() }

// ResetScreenCaptureKitVerdict removes the recorded verdict, so the next
// capture session tries ScreenCaptureKit again. A helper process that latched
// in memory (the verdict could not be saved) keeps CoreGraphics until it
// restarts.
func ResetScreenCaptureKitVerdict() (path string, removed bool, err error) { return sckPolicy.reset() }

// PinCoreGraphicsCapture records an operator verdict: capture sessions for
// this account use CoreGraphics and never call ScreenCaptureKit, across
// upgrades and permission changes, until ResetScreenCaptureKitVerdict.
func PinCoreGraphicsCapture() (path string, err error) { return sckPolicy.pinCoreGraphics() }
