//go:build darwin && cgo

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// darwinFakes swaps every macOS capture seam for a fake: no test here opens a
// real ScreenCaptureKit stream (which could raise the consent dialog on the
// developer's Mac) or touches the real ~/Library verdict.
type darwinFakes struct {
	sck, cg   *scriptedBackend
	preflight bool
	fp        sckFingerprint
	store     *sckVerdictStore
	storeErr  error
}

func installDarwinFakes(t *testing.T, sck, cg *scriptedBackend) *darwinFakes {
	t.Helper()
	if !hasSCScreenshotManager() {
		t.Skip("host is older than macOS 14; the ScreenCaptureKit path is not used")
	}
	f := &darwinFakes{
		sck: sck, cg: cg, preflight: true, fp: testFingerprint(),
		store: &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()},
	}
	saveSCK, saveCG, savePre := openSCKCapturer, openCGCapturer, screenRecordingPreflight
	saveStore, saveFP, saveLatch := sckVerdictStoreFn, sckFingerprintFn, sckCaptureUnhealthy.Load()
	t.Cleanup(func() {
		openSCKCapturer, openCGCapturer, screenRecordingPreflight = saveSCK, saveCG, savePre
		sckVerdictStoreFn, sckFingerprintFn = saveStore, saveFP
		sckCaptureUnhealthy.Store(saveLatch)
	})
	openSCKCapturer = func(CaptureConfig) (ScreenCapturer, error) { return sck.step().open() }
	openCGCapturer = func(CaptureConfig) (ScreenCapturer, error) { return cg.step().open() }
	screenRecordingPreflight = func() bool { return f.preflight }
	sckVerdictStoreFn = func() (*sckVerdictStore, error) {
		if f.storeErr != nil {
			return nil, f.storeErr
		}
		return f.store, nil
	}
	sckFingerprintFn = func() sckFingerprint { return f.fp }
	sckCaptureUnhealthy.Store(false)
	return f
}

func userSession() CaptureConfig { return CaptureConfig{DesktopContext: "user_session"} }

func TestDarwinCaptureProbePlan_LoginWindowKeepsDefault(t *testing.T) {
	plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "login_window"}, CaptureProbeOptions{AllowScreenCaptureKit: true})
	if plan.fallback != nil || plan.primary.name != "platform" || plan.primaryAttempts != 1 {
		t.Fatalf("login_window plan = %+v, want the default single attempt", plan)
	}
}

// #8058: the permission-check probe (TCC loop, re-probe, connect probe,
// startup log, CLI without --sck) must never call ScreenCaptureKit.
func TestProbeCaptureAccess_NeverCallsScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	installDarwinFakes(t, sck, cg)

	for i := 0; i < 3; i++ {
		granted, err := ProbeCaptureAccess(userSession())
		if err != nil || !granted {
			t.Fatalf("ProbeCaptureAccess = %v, %v", granted, err)
		}
	}
	if sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times by permission checks, want 0", sck.opened)
	}
	if cg.opened != 3 || cg.closed != 3 {
		t.Fatalf("CoreGraphics opened=%d closed=%d, want 3/3", cg.opened, cg.closed)
	}
}

// The CLI's `probe --sck`: ScreenCaptureKit once, and nothing recorded — its
// capture is charged to whatever launched the CLI, not to the helper.
func TestProbeCapture_ExplicitSCKProbeCallsOnceAndRecordsNothing(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)

	report, err := ProbeCapture(userSession(), CaptureProbeOptions{AllowScreenCaptureKit: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report.ScreenCaptureKitCalls != 1 || sck.opened != 1 || report.Backend != captureBackendCoreGraphics {
		t.Fatalf("report = %+v (sck opened %d), want 1 SCK call then coregraphics", report, sck.opened)
	}
	if v, err := f.store.load(); err != nil || v != nil {
		t.Fatalf("an explicit probe recorded a verdict: %+v, %v", v, err)
	}
	if sckCaptureUnhealthy.Load() {
		t.Fatal("an explicit probe latched the in-process verdict")
	}
}

// The field case (#5953/#8058): the user declines ScreenCaptureKit's consent
// (-3801) while Screen Recording is granted. The session falls back to
// CoreGraphics, records "declined", and does not ask again.
func TestNewPlatformCapturer_DeclineIsRecordedAndNotRetried(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cg.opened != 1 || cg.closed != 0 {
		t.Fatalf("CoreGraphics opened=%d closed=%d, want an open CG capturer", cg.opened, cg.closed)
	}
	_ = capturer.Close()
	if sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 1 (a refusal is not retried)", sck.opened)
	}
	v, err := f.store.load()
	if err != nil || v == nil {
		t.Fatalf("no verdict recorded: %+v, %v", v, err)
	}
	if v.Reason != sckVerdictReasonDeclined || v.Fingerprint != f.fp {
		t.Fatalf("verdict = %+v, want declined with the current fingerprint", v)
	}
	if sckCaptureUnhealthy.Load() {
		t.Fatal("latched in memory although the verdict was saved")
	}
}

// The restart case: a new helper process (no in-memory latch) finds the
// recorded verdict and never calls ScreenCaptureKit.
func TestNewPlatformCapturer_RecordedVerdictSkipsScreenCaptureKitAfterRestart(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	if err := f.store.save(newSCKVerdict(sckVerdictReasonDeclined, "", sckVerdictNow(), f.fp)); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 3; i++ {
		capturer, err := newPlatformCapturer(userSession())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		_ = capturer.Close()
	}
	if sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times with a recorded verdict, want 0", sck.opened)
	}
	if cg.opened != 3 {
		t.Fatalf("CoreGraphics opened %d times, want 3", cg.opened)
	}
}

func TestNewPlatformCapturer_OperatorPinSkipsScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	if _, err := PinCoreGraphicsCapture(); err != nil {
		t.Fatal(err)
	}
	f.fp.HelperSize++ // an upgrade does not undo an operator pin
	f.preflight = false

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = capturer.Close()
	if sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times despite an operator pin", sck.opened)
	}
	if status := ScreenCaptureKitVerdict(); !status.Applies || status.Reason != sckVerdictReasonOperator {
		t.Fatalf("status = %+v, want an applicable operator pin", status)
	}
}

// "Until permissions change": a stale verdict lets ScreenCaptureKit try again,
// and a success removes it.
func TestNewPlatformCapturer_StaleVerdictRetriesAndSuccessClearsIt(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	if err := f.store.save(newSCKVerdict(sckVerdictReasonCaptureFailed, "", sckVerdictNow(), f.fp)); err != nil {
		t.Fatal(err)
	}
	f.fp.OSBuild = "25A999" // macOS updated

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = capturer.Close()
	if sck.opened != 1 || cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want ScreenCaptureKit only", sck.opened, cg.opened)
	}
	if v, err := f.store.load(); err != nil || v != nil {
		t.Fatalf("stale verdict survived a ScreenCaptureKit success: %+v, %v", v, err)
	}
}

// Healthy hosts keep ScreenCaptureKit and record nothing.
func TestNewPlatformCapturer_HealthyHostUsesScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sck.closed != 0 {
		t.Fatal("the working ScreenCaptureKit capturer was closed")
	}
	_ = capturer.Close()
	if sck.opened != 1 || cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want ScreenCaptureKit only", sck.opened, cg.opened)
	}
	if v, err := f.store.load(); err != nil || v != nil {
		t.Fatalf("a healthy host recorded a verdict: %+v, %v", v, err)
	}
}

// #6105 kept: ScreenCaptureKit never answers, CoreGraphics does → recorded
// as capture_failed after the retry.
func TestNewPlatformCapturer_CaptureFailureRetriesThenRecords(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{
		{err: errSCKTimeout}, {err: errSCKTimeout},
	}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = capturer.Close()
	if sck.opened != sckProbeAttempts {
		t.Fatalf("ScreenCaptureKit opened %d times, want %d", sck.opened, sckProbeAttempts)
	}
	if v, _ := f.store.load(); v == nil || v.Reason != sckVerdictReasonCaptureFailed {
		t.Fatalf("verdict = %+v, want capture_failed", v)
	}
}

// Without the Screen Recording grant a CoreGraphics frame can be wallpaper
// only, so a capture-phase failure must not fall back, and nothing is
// recorded.
func TestNewPlatformCapturer_NoPreflightNoFallbackNoVerdict(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	f.preflight = false

	if _, err := newPlatformCapturer(userSession()); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("err = %v, want ErrPermissionDenied", err)
	}
	if cg.opened != 0 {
		t.Fatalf("CoreGraphics opened %d times without a Screen Recording grant", cg.opened)
	}
	if v, _ := f.store.load(); v != nil {
		t.Fatalf("recorded %+v without a working fallback", v)
	}
}

// Init-phase failures are transient-prone and fall back on every call; they
// are not recorded, so a healthy host is never pinned to CoreGraphics by one.
func TestNewPlatformCapturer_InitFailureFallsBackWithoutRecording(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, openErr: errors.New("display reconfiguring")}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)

	capturer, err := newPlatformCapturer(userSession())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = capturer.Close()
	if v, _ := f.store.load(); v != nil {
		t.Fatalf("recorded %+v after an init-phase failure", v)
	}
	if sckCaptureUnhealthy.Load() {
		t.Fatal("latched after an init-phase failure")
	}
}

// When the verdict cannot be saved, the process still stops asking
// ScreenCaptureKit (the pre-#8058 latch).
func TestNewPlatformCapturer_UnsavableVerdictLatchesInProcess(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	f.storeErr = errors.New("no home directory")

	for i := 0; i < 2; i++ {
		capturer, err := newPlatformCapturer(userSession())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		_ = capturer.Close()
	}
	if !sckCaptureUnhealthy.Load() {
		t.Fatal("did not latch when the verdict could not be saved")
	}
	if sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 1", sck.opened)
	}
}

func TestResetScreenCaptureKitVerdict(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	f := installDarwinFakes(t, sck, cg)
	if err := f.store.save(newSCKVerdict(sckVerdictReasonDeclined, "", sckVerdictNow(), f.fp)); err != nil {
		t.Fatal(err)
	}
	path, removed, err := ResetScreenCaptureKitVerdict()
	if err != nil || !removed || path != f.store.path() {
		t.Fatalf("reset = %q, %v, %v", path, removed, err)
	}
	if status := ScreenCaptureKitVerdict(); status.Present {
		t.Fatalf("verdict still present after reset: %+v", status)
	}
}
