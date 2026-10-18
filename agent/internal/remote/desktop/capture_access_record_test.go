//go:build unix

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #8390: a real session that captured through ScreenCaptureKit proves the
// Screen Recording grant under the current fingerprint; the non-capturing
// access check reads that record where preflight is unreliable.

func TestCaptureAccessStore_RoundTripAndAbsent(t *testing.T) {
	s := newTestVerdictStore(t)
	if r, err := s.loadAccess(); err != nil || r != nil {
		t.Fatalf("absent record: got %+v, %v", r, err)
	}
	at := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if err := s.saveAccess(newCaptureAccessRecord(at, testFingerprint())); err != nil {
		t.Fatalf("save: %v", err)
	}
	r, err := s.loadAccess()
	if err != nil || r == nil {
		t.Fatalf("load: got %+v, %v", r, err)
	}
	if !r.RecordedAt.Equal(at) || r.Fingerprint != testFingerprint() || r.Backend != captureBackendScreenCaptureKit {
		t.Fatalf("record = %+v", r)
	}
	info, err := os.Lstat(filepath.Join(s.dir, captureAccessFileName))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("record file mode = %v, err %v, want 0600", info, err)
	}
	// The ScreenCaptureKit verdict file is a separate record.
	if v, err := s.load(); err != nil || v != nil {
		t.Fatalf("verdict after saving the access record: %+v, %v", v, err)
	}
}

func TestCaptureAccessStore_RejectsForeignRecord(t *testing.T) {
	s := newTestVerdictStore(t)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, captureAccessFileName), []byte(`{"schema":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, err := s.loadAccess(); err == nil || r != nil {
		t.Fatalf("unrecognised record accepted: %+v, %v", r, err)
	}
}

func TestSessionPolicy_ScreenCaptureKitSuccessRecordsAccess(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.preflight = false
	h.fp.ScreenRecordingPreflight = false

	h.mustOpenAndClose(t)
	r, err := h.store.loadAccess()
	if err != nil || r == nil {
		t.Fatalf("access record after a ScreenCaptureKit session: %+v, %v", r, err)
	}
	if r.Fingerprint != h.fp {
		t.Fatalf("record fingerprint = %+v, want %+v", r.Fingerprint, h.fp)
	}
	if !h.policy().lastSessionCaptured() {
		t.Fatal("lastSessionCaptured false right after recording")
	}
}

// A CoreGraphics fallback frame proves nothing about the grant (without it
// CoreGraphics still returns wallpaper), so it is never recorded as access.
func TestSessionPolicy_CoreGraphicsFallbackDoesNotRecordAccess(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}},
		&scriptedBackend{name: captureBackendCoreGraphics})

	h.mustOpenAndClose(t)
	if r, _ := h.store.loadAccess(); r != nil {
		t.Fatalf("access recorded from a CoreGraphics fallback: %+v", r)
	}
	if h.policy().lastSessionCaptured() {
		t.Fatal("lastSessionCaptured true with no record")
	}
}

func TestSessionPolicy_LastSessionCapturedHonoursFingerprint(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.mustOpenAndClose(t)

	h.fp.HelperModTime++ // the helper binary was replaced
	if h.policy().lastSessionCaptured() {
		t.Fatal("stale record (new helper binary) still counted as a grant")
	}
	h.fp = testFingerprint()
	h.fp.OSBuild = "25A100"
	if h.policy().lastSessionCaptured() {
		t.Fatal("stale record (macOS update) still counted as a grant")
	}

	h.fp = testFingerprint()
	h.storeErr = errors.New("no home")
	if h.policy().lastSessionCaptured() {
		t.Fatal("unlocatable store counted as a grant")
	}
}

// A refusal from ScreenCaptureKit (-3801) with no CoreGraphics fallback
// (preflight false) means the grant may be gone: the record must not outlive
// it.
func TestSessionPolicy_PermissionRefusalClearsAccessRecord(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.preflight = false
	h.fp.ScreenRecordingPreflight = false
	h.mustOpenAndClose(t)
	if !h.policy().lastSessionCaptured() {
		t.Fatal("precondition: no access record after a ScreenCaptureKit session")
	}

	h.sck = &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: ErrPermissionDenied}}}
	if _, err := h.open(t); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("err = %v, want ErrPermissionDenied", err)
	}
	if h.policy().lastSessionCaptured() {
		t.Fatal("access record survived a permission refusal")
	}
}

func TestSessionPolicy_ResetClearsAccessRecordToo(t *testing.T) {
	h := newSessionHarness(t,
		&scriptedBackend{name: captureBackendScreenCaptureKit},
		&scriptedBackend{name: captureBackendCoreGraphics})
	h.mustOpenAndClose(t)
	if _, _, err := h.policy().reset(); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if r, _ := h.store.loadAccess(); r != nil {
		t.Fatalf("access record survived reset: %+v", r)
	}
}
