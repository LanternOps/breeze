//go:build darwin && cgo

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
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
	origPreflight, origNames, origMajor := screenRecordingPreflight, namedWindowVisibleFn, macOSMajorVersion
	t.Cleanup(func() {
		screenRecordingPreflight, namedWindowVisibleFn, macOSMajorVersion = origPreflight, origNames, origMajor
	})
	screenRecordingPreflight = func() bool { return false }
	namedWindowVisibleFn = func() bool {
		t.Fatal("window names consulted at the login window")
		return true
	}
	for _, tc := range []struct {
		name  string
		major int
		want  CaptureAccessState
		why   string
	}{
		// Preflight is trustworthy below macOS 26: its "no" is a denial.
		{"macOS 15", 24, CaptureAccessDenied, "preflight"},
		// macOS 26 can report false while the grant is present; with no other
		// signal available at the login window the answer is unknown, not denied.
		{"macOS 26", 25, CaptureAccessUnknown, "unverified"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			macOSMajorVersion = tc.major
			report := CheckCaptureAccess(CaptureConfig{DesktopContext: "login_window"})
			if report.State != tc.want || report.Reason != tc.why {
				t.Fatalf("report = %+v, want %s by %s", report, tc.want, tc.why)
			}
		})
	}
}

// The TCC check loop and the capture re-probe call CheckCaptureAccess from
// separate goroutines; the once-per-process "unverified" warning flag they
// share must be safe under -race.
func TestCheckCaptureAccess_ConcurrentUnverifiedWarningIsRaceFree(t *testing.T) {
	origPreflight, origNames, origPolicy, origMajor := screenRecordingPreflight, namedWindowVisibleFn, sckPolicy, macOSMajorVersion
	t.Cleanup(func() {
		screenRecordingPreflight, namedWindowVisibleFn, sckPolicy, macOSMajorVersion = origPreflight, origNames, origPolicy, origMajor
		captureAccessUnverifiedWarned.Store(false)
	})
	// macOS 26: preflight unreliable, no titled window, no recorded session
	// -> unknown, the state that logs the warning.
	macOSMajorVersion = 25
	screenRecordingPreflight = func() bool { return false }
	namedWindowVisibleFn = func() bool { return false }
	store := &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()}
	sckPolicy = sckSessionPolicy{
		store:       func() (*sckVerdictStore, error) { return store, nil },
		fingerprint: testFingerprint,
		now:         time.Now,
		preflight:   func() bool { return false },
		latch:       sckPolicy.latch,
	}
	captureAccessUnverifiedWarned.Store(false)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r := CheckCaptureAccess(CaptureConfig{}); r.State != CaptureAccessUnknown {
				t.Errorf("report = %+v, want unknown", r)
			}
		}()
	}
	wg.Wait()
	if !captureAccessUnverifiedWarned.Load() {
		t.Fatal("unverified warning flag not set after an unknown report")
	}
}
