//go:build unix

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// sessionHarness is a sckSessionPolicy over fake backends and a temp store,
// so the session-side ScreenCaptureKit decisions (#8058) run in Linux CI.
type sessionHarness struct {
	sck, cg   *scriptedBackend
	preflight bool
	fp        sckFingerprint
	store     *sckVerdictStore
	storeErr  error
	latch     atomic.Bool
}

func newSessionHarness(t *testing.T, sck, cg *scriptedBackend) *sessionHarness {
	t.Helper()
	return &sessionHarness{
		sck: sck, cg: cg, preflight: true, fp: testFingerprint(),
		store: &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()},
	}
}

func (h *sessionHarness) policy() sckSessionPolicy {
	return sckSessionPolicy{
		store: func() (*sckVerdictStore, error) {
			if h.storeErr != nil {
				return nil, h.storeErr
			}
			return h.store, nil
		},
		fingerprint: func() sckFingerprint { return h.fp },
		now:         func() time.Time { return time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC) },
		preflight:   func() bool { return h.preflight },
		latch:       &h.latch,
	}
}

func (h *sessionHarness) backends() macCaptureBackends {
	return fakeMacBackends(h.sck, h.cg, h.preflight)
}

// open runs one session open with the production attempt count (no delay).
func (h *sessionHarness) open(t *testing.T) (ScreenCapturer, error) {
	t.Helper()
	b := h.backends()
	b.preflight = func() bool { return h.preflight }
	return h.policy().openSessionCapturer(b, 2, 0)
}

func (h *sessionHarness) mustOpenAndClose(t *testing.T) {
	t.Helper()
	c, err := h.open(t)
	if err != nil {
		t.Fatalf("open session capturer: %v", err)
	}
	_ = c.Close()
}

// The field case (#5953/#8058): the user declines ScreenCaptureKit's consent
// (-3801) while Screen Recording is granted. The session falls back to
// CoreGraphics, records "declined", and does not ask again.
func TestSessionPolicy_DeclineIsRecordedAndNotRetried(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}},
		&scriptedBackend{name: captureBackendCoreGraphics})

	c, err := h.open(t)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h.cg.opened != 1 || h.cg.closed != 0 {
		t.Fatalf("CoreGraphics opened=%d closed=%d, want an open CG capturer", h.cg.opened, h.cg.closed)
	}
	_ = c.Close()
	if h.sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 1 (a refusal is not retried)", h.sck.opened)
	}
	v, err := h.store.load()
	if err != nil || v == nil {
		t.Fatalf("no verdict recorded: %+v, %v", v, err)
	}
	if v.Reason != sckVerdictReasonDeclined || v.Fingerprint != h.fp {
		t.Fatalf("verdict = %+v, want declined with the current fingerprint", v)
	}
	if h.latch.Load() {
		t.Fatal("latched in memory although the verdict was saved")
	}
}

// The restart case: a new helper process (fresh policy, no latch) finds the
// recorded verdict and never calls ScreenCaptureKit.
func TestSessionPolicy_RecordedVerdictSkipsScreenCaptureKitAfterRestart(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})
	if err := h.store.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), h.fp)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		h.mustOpenAndClose(t)
	}
	if h.sck.opened != 0 || h.cg.opened != 3 {
		t.Fatalf("opened sck=%d cg=%d, want 0/3", h.sck.opened, h.cg.opened)
	}
}

func TestSessionPolicy_OperatorPinSkipsScreenCaptureKit(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})
	if _, err := h.policy().pinCoreGraphics(); err != nil {
		t.Fatal(err)
	}
	h.fp.HelperSize++ // an upgrade does not undo an operator pin
	h.preflight = false

	h.mustOpenAndClose(t)
	if h.sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times despite an operator pin", h.sck.opened)
	}
	if status := h.policy().status(); !status.Applies || status.Reason != sckVerdictReasonOperator {
		t.Fatalf("status = %+v, want an applicable operator pin", status)
	}
}

// "Until permissions change": a stale verdict lets ScreenCaptureKit try again,
// and a success removes it.
func TestSessionPolicy_StaleVerdictRetriesAndSuccessClearsIt(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})
	if err := h.store.save(newSCKVerdict(sckVerdictReasonCaptureFailed, "", time.Now(), h.fp)); err != nil {
		t.Fatal(err)
	}
	h.fp.OSBuild = "25A999" // macOS updated

	h.mustOpenAndClose(t)
	if h.sck.opened != 1 || h.cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want ScreenCaptureKit only", h.sck.opened, h.cg.opened)
	}
	if v, err := h.store.load(); err != nil || v != nil {
		t.Fatalf("stale verdict survived a ScreenCaptureKit success: %+v, %v", v, err)
	}
}

// Healthy hosts keep ScreenCaptureKit and record nothing.
func TestSessionPolicy_HealthyHostUsesScreenCaptureKit(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})

	c, err := h.open(t)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h.sck.closed != 0 {
		t.Fatal("the working ScreenCaptureKit capturer was closed")
	}
	_ = c.Close()
	if h.sck.opened != 1 || h.cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want ScreenCaptureKit only", h.sck.opened, h.cg.opened)
	}
	if v, err := h.store.load(); err != nil || v != nil {
		t.Fatalf("a healthy host recorded a verdict: %+v, %v", v, err)
	}
}

// #6105 kept: ScreenCaptureKit never answers, CoreGraphics does → recorded
// as capture_failed after the retry.
func TestSessionPolicy_CaptureFailureRetriesThenRecords(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: errSCKTimeout}, {err: errSCKTimeout}}},
		&scriptedBackend{name: captureBackendCoreGraphics})

	h.mustOpenAndClose(t)
	if h.sck.opened != 2 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 2", h.sck.opened)
	}
	if v, _ := h.store.load(); v == nil || v.Reason != sckVerdictReasonCaptureFailed {
		t.Fatalf("verdict = %+v, want capture_failed", v)
	}
}

// Without the Screen Recording grant a CoreGraphics frame can be wallpaper
// only, so a capture-phase failure must not fall back, and nothing is
// recorded.
func TestSessionPolicy_NoPreflightNoFallbackNoVerdict(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.preflight = false

	if _, err := h.open(t); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("err = %v, want ErrPermissionDenied", err)
	}
	if h.cg.opened != 0 {
		t.Fatalf("CoreGraphics opened %d times without a Screen Recording grant", h.cg.opened)
	}
	if v, _ := h.store.load(); v != nil {
		t.Fatalf("recorded %+v without a working fallback", v)
	}
}

// Init-phase failures are transient-prone and fall back on every call; they
// are not recorded, so a healthy host is never pinned to CoreGraphics by one.
func TestSessionPolicy_InitFailureFallsBackWithoutRecording(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, openErr: errors.New("display reconfiguring")},
		&scriptedBackend{name: captureBackendCoreGraphics})

	h.mustOpenAndClose(t)
	if v, _ := h.store.load(); v != nil {
		t.Fatalf("recorded %+v after an init-phase failure", v)
	}
	if h.latch.Load() {
		t.Fatal("latched after an init-phase failure")
	}
}

// When the verdict cannot be saved, the process still stops asking
// ScreenCaptureKit (the pre-#8058 latch).
func TestSessionPolicy_UnsavableVerdictLatchesInProcess(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.storeErr = errors.New("no home directory")

	h.mustOpenAndClose(t)
	h.mustOpenAndClose(t)
	if !h.latch.Load() {
		t.Fatal("did not latch when the verdict could not be saved")
	}
	if h.sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 1", h.sck.opened)
	}
}

// A refused (e.g. world-writable) verdict counts as absent: the session tries
// ScreenCaptureKit rather than trusting it.
func TestSessionPolicy_RefusedVerdictIsIgnored(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})
	if err := h.store.save(newSCKVerdict(sckVerdictReasonOperator, "", time.Now(), h.fp)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(h.store.path(), 0o666); err != nil {
		t.Fatal(err)
	}
	if status := h.policy().status(); status.Error == "" || status.Applies {
		t.Fatalf("status = %+v, want the refusal surfaced in Error and not applied", status)
	}
	h.mustOpenAndClose(t)
	if h.sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 1: a refused verdict must not be trusted", h.sck.opened)
	}
}

func TestSessionPolicy_Reset(t *testing.T) {
	h := newSessionHarness(t, &scriptedBackend{name: captureBackendScreenCaptureKit}, &scriptedBackend{name: captureBackendCoreGraphics})
	if err := h.store.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), h.fp)); err != nil {
		t.Fatal(err)
	}
	path, removed, err := h.policy().reset()
	if err != nil || !removed || path != h.store.path() {
		t.Fatalf("reset = %q, %v, %v", path, removed, err)
	}
	if status := h.policy().status(); status.Present {
		t.Fatalf("verdict still present after reset: %+v", status)
	}
}
