package desktop

import (
	"errors"
	"image"
	"strings"
	"testing"
)

// fakeProbeCapturer is a ScreenCapturer whose single frame (or error) is
// scripted by the test. Close is counted so the probe's resource hygiene —
// every capturer it opens must be closed, because on macOS an open capturer
// holds darwinCaptureMu and would deadlock the next backend — is asserted.
type fakeProbeCapturer struct {
	frame  *image.RGBA
	err    error
	closed *int
}

func (f *fakeProbeCapturer) Capture() (*image.RGBA, error) { return f.frame, f.err }
func (f *fakeProbeCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return f.frame, f.err
}
func (f *fakeProbeCapturer) GetScreenBounds() (int, int, error) { return 1, 1, nil }
func (f *fakeProbeCapturer) Close() error {
	if f.closed != nil {
		*f.closed++
	}
	return nil
}

func goodFrame() *image.RGBA { return image.NewRGBA(image.Rect(0, 0, 4, 4)) }

// scriptedBackend returns a backend whose open() hands out the scripted
// capturers in order and records how many times it was opened.
type scriptedBackend struct {
	name    string
	openErr error
	frames  []*fakeProbeCapturer
	opened  int
	closed  int
}

func (s *scriptedBackend) step() captureProbeBackend {
	return captureProbeBackend{
		name: s.name,
		open: func() (ScreenCapturer, error) {
			s.opened++
			if s.openErr != nil {
				return nil, s.openErr
			}
			if len(s.frames) == 0 {
				return &fakeProbeCapturer{frame: goodFrame(), closed: &s.closed}, nil
			}
			next := s.frames[0]
			s.frames = s.frames[1:]
			next.closed = &s.closed
			return next, nil
		},
	}
}

var errSCKTimeout = errors.New("ScreenCaptureKit did not answer within the timeout")

func TestProbeCaptureBackends_PrimarySucceedsFirstTry(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit"}
	cg := &scriptedBackend{name: "coregraphics"}
	fallback := cg.step()

	res, err := probeCaptureBackends(captureProbePlan{
		primary:         sck.step(),
		primaryAttempts: 2,
		fallback:        &fallback,
		allowCaptureFallback: func() bool {
			t.Fatal("fallback gate consulted although the primary produced a frame")
			return false
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.backend != "screencapturekit" || res.primaryCaptureFailed {
		t.Fatalf("got %+v, want screencapturekit with no capture failure", res)
	}
	if sck.opened != 1 || cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want 1/0", sck.opened, cg.opened)
	}
	if sck.closed != 1 {
		t.Fatalf("primary capturer closed %d times, want 1", sck.closed)
	}
}

// The #6105 case: SCK initialises fine but its one-shot capture times out.
// The probe must retry SCK once, then try CoreGraphics, and report the
// backend that actually produced a frame.
func TestProbeCaptureBackends_CapturePhaseFailureRetriesThenFallsBack(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{err: errSCKTimeout},
	}}
	cg := &scriptedBackend{name: "coregraphics"}
	fallback := cg.step()
	gateCalls := 0

	res, err := probeCaptureBackends(captureProbePlan{
		primary:              sck.step(),
		primaryAttempts:      2,
		fallback:             &fallback,
		allowCaptureFallback: func() bool { gateCalls++; return true },
	})
	if err != nil {
		t.Fatalf("expected the CoreGraphics fallback to succeed, got %v", err)
	}
	if res.backend != "coregraphics" {
		t.Fatalf("backend = %q, want coregraphics", res.backend)
	}
	if !res.primaryCaptureFailed {
		t.Fatal("primaryCaptureFailed = false; the caller needs it to stop routing sessions to SCK")
	}
	if sck.opened != 2 {
		t.Fatalf("SCK opened %d times, want 2 (first attempt + one retry)", sck.opened)
	}
	if cg.opened != 1 {
		t.Fatalf("CG opened %d times, want 1", cg.opened)
	}
	if gateCalls != 1 {
		t.Fatalf("fallback gate consulted %d times, want 1", gateCalls)
	}
	if sck.closed != 2 || cg.closed != 1 {
		t.Fatalf("closed sck=%d cg=%d, want 2/1 — every capturer the probe opens must be closed", sck.closed, cg.closed)
	}
}

func TestProbeCaptureBackends_TransientCaptureFailureRecoversOnRetry(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{frame: goodFrame()},
	}}
	cg := &scriptedBackend{name: "coregraphics"}
	fallback := cg.step()

	res, err := probeCaptureBackends(captureProbePlan{
		primary:              sck.step(),
		primaryAttempts:      2,
		fallback:             &fallback,
		allowCaptureFallback: func() bool { return true },
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.backend != "screencapturekit" || res.primaryCaptureFailed {
		t.Fatalf("got %+v, want screencapturekit recovered on retry", res)
	}
	if cg.opened != 0 {
		t.Fatalf("CG opened %d times although SCK recovered", cg.opened)
	}
}

// When the capture failure could be a missing Screen Recording grant, a
// CoreGraphics capture would still "succeed" — it returns the wallpaper and
// menu bar without other apps' windows — and report a false CanCapture=true.
// The gate must stop the fallback and the primary's error must survive.
func TestProbeCaptureBackends_CaptureFallbackRefusedByGate(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{err: ErrPermissionDenied},
		{err: ErrPermissionDenied},
	}}
	cg := &scriptedBackend{name: "coregraphics"}
	fallback := cg.step()

	_, err := probeCaptureBackends(captureProbePlan{
		primary:              sck.step(),
		primaryAttempts:      2,
		fallback:             &fallback,
		allowCaptureFallback: func() bool { return false },
	})
	if err == nil {
		t.Fatal("expected an error when the fallback gate refuses")
	}
	if !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("error %v does not wrap the primary's ErrPermissionDenied", err)
	}
	if cg.opened != 0 {
		t.Fatalf("CG opened %d times although the gate refused", cg.opened)
	}
}

func TestProbeCaptureBackends_BothBackendsFailReportsBoth(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{err: errSCKTimeout},
	}}
	cgErr := errors.New("cg exploded")
	cg := &scriptedBackend{name: "coregraphics", frames: []*fakeProbeCapturer{{err: cgErr}}}
	fallback := cg.step()

	_, err := probeCaptureBackends(captureProbePlan{
		primary:              sck.step(),
		primaryAttempts:      2,
		fallback:             &fallback,
		allowCaptureFallback: func() bool { return true },
	})
	if err == nil {
		t.Fatal("expected an error when both backends fail")
	}
	if !errors.Is(err, cgErr) || !errors.Is(err, errSCKTimeout) {
		t.Fatalf("error %v must carry both the SCK and the CG failure", err)
	}
	for _, want := range []string{"screencapturekit", "coregraphics"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not name backend %q", err, want)
		}
	}
}

// An init-phase failure is not retried (initCapture already walks three
// content-request selectors) and falls back without the capture gate, which
// is exactly what newPlatformCapturer has always done.
func TestProbeCaptureBackends_InitFailureFallsBackWithoutGateOrRetry(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", openErr: errors.New("SCK classes did not load")}
	cg := &scriptedBackend{name: "coregraphics"}
	fallback := cg.step()

	res, err := probeCaptureBackends(captureProbePlan{
		primary:         sck.step(),
		primaryAttempts: 2,
		fallback:        &fallback,
		allowCaptureFallback: func() bool {
			t.Fatal("capture gate consulted for an init-phase failure")
			return false
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.backend != "coregraphics" || res.primaryCaptureFailed {
		t.Fatalf("got %+v, want coregraphics via init fallback (not a capture-phase failure)", res)
	}
	if sck.opened != 1 {
		t.Fatalf("SCK opened %d times, want 1 (init failures are not retried)", sck.opened)
	}
}

func TestProbeCaptureBackends_EmptyFrameCountsAsCaptureFailure(t *testing.T) {
	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{frame: image.NewRGBA(image.Rectangle{})},
	}}

	_, err := probeCaptureBackends(captureProbePlan{
		primary:         sck.step(),
		primaryAttempts: 1,
	})
	if err == nil {
		t.Fatal("an empty frame must not count as a successful capture")
	}
}

// With no fallback configured (every non-darwin platform, and the macOS login
// window path) behaviour is the historical single attempt.
func TestProbeCaptureBackends_NoFallbackSingleAttempt(t *testing.T) {
	sck := &scriptedBackend{name: "platform", frames: []*fakeProbeCapturer{{err: errSCKTimeout}}}

	_, err := probeCaptureBackends(captureProbePlan{
		primary:         sck.step(),
		primaryAttempts: 1,
	})
	if !errors.Is(err, errSCKTimeout) {
		t.Fatalf("got %v, want the primary error unchanged", err)
	}
	if sck.opened != 1 {
		t.Fatalf("opened %d times, want 1", sck.opened)
	}
}

func TestProbeCaptureAccess_UsesPlatformPlanAndReportsResult(t *testing.T) {
	restore := platformCaptureProbePlan
	t.Cleanup(func() { platformCaptureProbePlan = restore })

	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{err: errSCKTimeout},
	}}
	cg := &scriptedBackend{name: "coregraphics"}
	var got *captureProbeResult
	platformCaptureProbePlan = func(CaptureConfig) captureProbePlan {
		fallback := cg.step()
		return captureProbePlan{
			primary:              sck.step(),
			primaryAttempts:      2,
			fallback:             &fallback,
			allowCaptureFallback: func() bool { return true },
			onSuccess:            func(r captureProbeResult) { got = &r },
		}
	}

	granted, err := ProbeCaptureAccess(DefaultConfig())
	if err != nil || !granted {
		t.Fatalf("ProbeCaptureAccess = %v, %v; want true, nil via the fallback", granted, err)
	}
	if got == nil || got.backend != "coregraphics" || !got.primaryCaptureFailed {
		t.Fatalf("onSuccess got %+v, want coregraphics after a primary capture failure", got)
	}
}

func TestProbeCaptureAccess_FailureDoesNotCallOnSuccess(t *testing.T) {
	restore := platformCaptureProbePlan
	t.Cleanup(func() { platformCaptureProbePlan = restore })

	sck := &scriptedBackend{name: "screencapturekit", frames: []*fakeProbeCapturer{{err: errSCKTimeout}}}
	platformCaptureProbePlan = func(CaptureConfig) captureProbePlan {
		return captureProbePlan{
			primary:         sck.step(),
			primaryAttempts: 1,
			onSuccess:       func(captureProbeResult) { t.Fatal("onSuccess called for a failed probe") },
		}
	}

	granted, err := ProbeCaptureAccess(DefaultConfig())
	if granted || !errors.Is(err, errSCKTimeout) {
		t.Fatalf("ProbeCaptureAccess = %v, %v; want false with the primary error", granted, err)
	}
}
