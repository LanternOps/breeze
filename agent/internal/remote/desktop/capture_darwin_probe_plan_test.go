//go:build darwin && cgo

package desktop

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These cover the darwin wiring only; the policy itself is tested in
// capture_backend_session_test.go and capture_backend_plan_test.go, which run
// in Linux CI. Every backend is faked: no test here opens a real
// ScreenCaptureKit stream (which could raise the consent dialog on the
// developer's Mac) or touches the real ~/Library verdict.
func installDarwinFakes(t *testing.T, sck, cg *scriptedBackend) *sckVerdictStore {
	t.Helper()
	if !hasSCScreenshotManager() {
		t.Skip("host is older than macOS 14; the ScreenCaptureKit path is not used")
	}
	store := &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()}
	saveSCK, saveCG, savePre, savePolicy, saveLatch := openSCKCapturer, openCGCapturer, screenRecordingPreflight, sckPolicy, sckCaptureUnhealthy.Load()
	t.Cleanup(func() {
		openSCKCapturer, openCGCapturer, screenRecordingPreflight, sckPolicy = saveSCK, saveCG, savePre, savePolicy
		sckCaptureUnhealthy.Store(saveLatch)
	})
	openSCKCapturer = func(CaptureConfig) (ScreenCapturer, error) { return sck.step().open() }
	openCGCapturer = func(CaptureConfig) (ScreenCapturer, error) { return cg.step().open() }
	screenRecordingPreflight = func() bool { return true }
	fp := testFingerprint()
	sckPolicy.store = func() (*sckVerdictStore, error) { return store, nil }
	sckPolicy.fingerprint = func() sckFingerprint { return fp }
	sckPolicy.now = time.Now
	sckCaptureUnhealthy.Store(false)
	return store
}

func userSession() CaptureConfig { return CaptureConfig{DesktopContext: "user_session"} }

func TestDarwinCaptureProbePlan_LoginWindowKeepsDefault(t *testing.T) {
	plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "login_window"}, CaptureProbeOptions{AllowScreenCaptureKit: true})
	if plan.fallback != nil || plan.primary.name != "platform" || plan.primaryAttempts != 1 {
		t.Fatalf("login_window plan = %+v, want the default single attempt", plan)
	}
}

// #8058: the real permission-check entry point never reaches the
// ScreenCaptureKit opener.
func TestProbeCaptureAccess_NeverCallsScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	installDarwinFakes(t, sck, cg)

	for i := 0; i < 3; i++ {
		if granted, err := ProbeCaptureAccess(userSession()); err != nil || !granted {
			t.Fatalf("ProbeCaptureAccess = %v, %v", granted, err)
		}
	}
	if sck.opened != 0 || cg.opened != 3 {
		t.Fatalf("opened sck=%d cg=%d, want 0/3", sck.opened, cg.opened)
	}
}

// newPlatformCapturer goes through the live session policy: a decline is
// recorded, and the next open (as after a restart) skips ScreenCaptureKit.
func TestNewPlatformCapturer_UsesSessionPolicy(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	store := installDarwinFakes(t, sck, cg)

	for i := 0; i < 2; i++ {
		c, err := newPlatformCapturer(userSession())
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		_ = c.Close()
	}
	if sck.opened != 1 || cg.opened != 2 {
		t.Fatalf("opened sck=%d cg=%d, want 1/2", sck.opened, cg.opened)
	}
	if v, err := store.load(); err != nil || v == nil || v.Reason != sckVerdictReasonDeclined {
		t.Fatalf("verdict = %+v, %v; want declined", v, err)
	}
	if status := ScreenCaptureKitVerdict(); !status.Applies {
		t.Fatalf("exported status = %+v, want an applicable verdict", status)
	}
}
