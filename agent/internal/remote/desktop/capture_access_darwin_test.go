//go:build darwin && cgo

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #8390: CheckCaptureAccess is what every background permission check runs.
// It must never open a capture backend, whatever the signals say.
func TestCheckCaptureAccess_NeverOpensABackend(t *testing.T) {
	origSCK, origCG, origPreflight, origNames, origPolicy := openSCKCapturer, openCGCapturer, screenRecordingPreflight, namedWindowVisibleFn, sckPolicy
	t.Cleanup(func() {
		openSCKCapturer, openCGCapturer, screenRecordingPreflight, namedWindowVisibleFn, sckPolicy = origSCK, origCG, origPreflight, origNames, origPolicy
	})
	openSCKCapturer = func(CaptureConfig) (ScreenCapturer, error) {
		t.Fatal("permission check opened ScreenCaptureKit")
		return nil, errors.New("unreachable")
	}
	openCGCapturer = func(CaptureConfig) (ScreenCapturer, error) {
		t.Fatal("permission check opened a CoreGraphics capturer")
		return nil, errors.New("unreachable")
	}
	store := &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()}
	sckPolicy = sckSessionPolicy{
		store:       func() (*sckVerdictStore, error) { return store, nil },
		fingerprint: testFingerprint,
		now:         time.Now,
		preflight:   func() bool { return false },
		latch:       sckPolicy.latch,
	}

	for _, tc := range []struct {
		name      string
		preflight bool
		named     bool
		context   string
	}{
		{"granted by preflight", true, false, "user_session"},
		{"preflight false, titled window", false, true, "user_session"},
		{"preflight false, nothing else", false, false, "user_session"},
		{"login window", false, true, "login_window"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			screenRecordingPreflight = func() bool { return tc.preflight }
			namedWindowVisibleFn = func() bool { return tc.named }
			report := CheckCaptureAccess(CaptureConfig{DesktopContext: tc.context})
			if report.Reason == "" {
				t.Fatalf("report = %+v, want a reason", report)
			}
		})
	}
}

// At the login window and on macOS 12/13 only preflight decides: a titled
// window or a recorded user session says nothing about that context.
func TestCheckCaptureAccess_LoginWindowIsPreflightOnly(t *testing.T) {
	origPreflight, origNames := screenRecordingPreflight, namedWindowVisibleFn
	t.Cleanup(func() { screenRecordingPreflight, namedWindowVisibleFn = origPreflight, origNames })
	screenRecordingPreflight = func() bool { return false }
	namedWindowVisibleFn = func() bool {
		t.Fatal("window names consulted at the login window")
		return true
	}
	report := CheckCaptureAccess(CaptureConfig{DesktopContext: "login_window"})
	if report.State != CaptureAccessDenied || report.Reason != "preflight" {
		t.Fatalf("report = %+v, want denied by preflight", report)
	}
}
