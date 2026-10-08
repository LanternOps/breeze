package desktop

import (
	"errors"
	"testing"
)

// fakeMacBackends wires scripted ScreenCaptureKit and CoreGraphics backends
// into macUserSessionPlan, so the ScreenCaptureKit call policy (#8058) is
// asserted on every platform, including the Linux CI job.
func fakeMacBackends(sck, cg *scriptedBackend, preflight bool) macCaptureBackends {
	return macCaptureBackends{
		openSCK:   sck.step().open,
		openCG:    cg.step().open,
		preflight: func() bool { return preflight },
	}
}

// Permission checks (the TCC check loop, the background re-probe, the
// connect-time capability probe, the CLI probe without --sck) build the plan
// with zero ScreenCaptureKit attempts. On Sequoia every ScreenCaptureKit call
// can raise macOS's own screen-recording consent dialog, so these must never
// reach it (#8058).
func TestMacUserSessionPlan_PermissionCheckNeverCallsScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}

	plan := macUserSessionPlan(fakeMacBackends(sck, cg, true), 0, 0)
	res, err := probeCaptureBackends(plan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times by a permission check, want 0", sck.opened)
	}
	if cg.opened != 1 || cg.closed != 1 {
		t.Fatalf("CoreGraphics opened=%d closed=%d, want 1/1", cg.opened, cg.closed)
	}
	if res.backend != captureBackendCoreGraphics {
		t.Fatalf("backend = %q, want coregraphics", res.backend)
	}
}

// Even when CoreGraphics fails, a permission check must not "try harder" with
// ScreenCaptureKit.
func TestMacUserSessionPlan_PermissionCheckFailureStillNeverCallsScreenCaptureKit(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cgErr := errors.New("no display")
	cg := &scriptedBackend{name: captureBackendCoreGraphics, openErr: cgErr}

	_, err := probeCaptureBackends(macUserSessionPlan(fakeMacBackends(sck, cg, true), 0, 0))
	if !errors.Is(err, cgErr) {
		t.Fatalf("err = %v, want the CoreGraphics error", err)
	}
	if sck.opened != 0 {
		t.Fatalf("ScreenCaptureKit opened %d times, want 0", sck.opened)
	}
}

// The CLI's explicit --sck probe: ScreenCaptureKit at most once per run.
func TestMacUserSessionPlan_SingleScreenCaptureKitAttempt(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{err: errSCKTimeout},
	}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}

	res, err := probeCaptureBackends(macUserSessionPlan(fakeMacBackends(sck, cg, true), 1, 0))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times, want exactly 1", sck.opened)
	}
	if res.backend != captureBackendCoreGraphics || !res.primaryCaptureFailed {
		t.Fatalf("got %+v, want a CoreGraphics frame after the SCK capture failure", res)
	}
}

// A real capture session keeps the #6105 behaviour: retry ScreenCaptureKit,
// then fall back to CoreGraphics only when Screen Recording preflight passes.
func TestMacUserSessionPlan_SessionFallbackIsGatedOnPreflight(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{
		{err: errSCKTimeout},
		{err: errSCKTimeout},
	}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}

	_, err := probeCaptureBackends(macUserSessionPlan(fakeMacBackends(sck, cg, false), 2, 0))
	if err == nil {
		t.Fatal("expected an error: preflight reports no grant, so the CG fallback must be refused")
	}
	if sck.opened != 2 || cg.opened != 0 {
		t.Fatalf("opened sck=%d cg=%d, want 2/0", sck.opened, cg.opened)
	}
}

func TestProbeCapture_ReportsBackendAndScreenCaptureKitCalls(t *testing.T) {
	restore := platformCaptureProbePlan
	t.Cleanup(func() { platformCaptureProbePlan = restore })

	sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: errSCKTimeout}}}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	var gotOpts []CaptureProbeOptions
	platformCaptureProbePlan = func(_ CaptureConfig, opts CaptureProbeOptions) captureProbePlan {
		gotOpts = append(gotOpts, opts)
		attempts := 0
		if opts.AllowScreenCaptureKit {
			attempts = 1
		}
		return macUserSessionPlan(fakeMacBackends(sck, cg, true), attempts, 0)
	}

	report, err := ProbeCapture(DefaultConfig(), CaptureProbeOptions{AllowScreenCaptureKit: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !report.Granted || report.Backend != captureBackendCoreGraphics || report.ScreenCaptureKitCalls != 1 {
		t.Fatalf("report = %+v, want granted via coregraphics after 1 SCK call", report)
	}

	// ProbeCaptureAccess is the permission-check entry point: it must ask
	// for a plan without ScreenCaptureKit.
	granted, err := ProbeCaptureAccess(DefaultConfig())
	if err != nil || !granted {
		t.Fatalf("ProbeCaptureAccess = %v, %v", granted, err)
	}
	if len(gotOpts) != 2 || gotOpts[1].AllowScreenCaptureKit {
		t.Fatalf("ProbeCaptureAccess requested options %+v, want AllowScreenCaptureKit=false", gotOpts)
	}
	if sck.opened != 1 {
		t.Fatalf("ScreenCaptureKit opened %d times in total, want 1 (only the explicit probe)", sck.opened)
	}
}

// macProbePlan is what darwinCaptureProbePlan returns for a macOS 14+ user
// session; the option-to-attempts mapping is asserted here so it runs in CI.
func TestMacProbePlan_ScreenCaptureKitOnlyWhenAllowedAndAtMostOnce(t *testing.T) {
	t.Run("permission check", func(t *testing.T) {
		sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
		cg := &scriptedBackend{name: captureBackendCoreGraphics}
		plan := macProbePlan(fakeMacBackends(sck, cg, true), CaptureProbeOptions{})
		if _, err := probeCaptureBackends(plan); err != nil {
			t.Fatal(err)
		}
		if sck.opened != 0 || cg.opened != 1 {
			t.Fatalf("opened sck=%d cg=%d, want 0/1", sck.opened, cg.opened)
		}
	})
	t.Run("explicit --sck", func(t *testing.T) {
		sck := &scriptedBackend{name: captureBackendScreenCaptureKit, frames: []*fakeProbeCapturer{{err: errSCKTimeout}, {err: errSCKTimeout}}}
		cg := &scriptedBackend{name: captureBackendCoreGraphics}
		plan := macProbePlan(fakeMacBackends(sck, cg, true), CaptureProbeOptions{AllowScreenCaptureKit: true})
		if _, err := probeCaptureBackends(plan); err != nil {
			t.Fatal(err)
		}
		if sck.opened != 1 {
			t.Fatalf("ScreenCaptureKit opened %d times, want 1", sck.opened)
		}
	})
}

// The permission-check probe is not gated on preflight (macOS 26 can report
// false while the grant is present), so a CG frame still counts as granted.
func TestMacProbePlan_PermissionCheckNotGatedOnPreflight(t *testing.T) {
	sck := &scriptedBackend{name: captureBackendScreenCaptureKit}
	cg := &scriptedBackend{name: captureBackendCoreGraphics}
	plan := macProbePlan(fakeMacBackends(sck, cg, false), CaptureProbeOptions{})
	res, err := probeCaptureBackends(plan)
	if err != nil || res.backend != captureBackendCoreGraphics {
		t.Fatalf("res=%+v err=%v, want a CoreGraphics frame", res, err)
	}
	if plan.onSuccess == nil {
		t.Fatal("the no-grant warning hook is missing")
	}
	plan.onSuccess(res) // must not panic; warns once
	plan.onSuccess(res)
}
