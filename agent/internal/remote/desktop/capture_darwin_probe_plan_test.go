//go:build darwin && cgo

package desktop

import "testing"

// These assert the plan's shape only; nothing is opened, so no capture or
// TCC prompt happens on the test host.
func TestDarwinCaptureProbePlan_Shape(t *testing.T) {
	restore := sckCaptureUnhealthy.Load()
	t.Cleanup(func() { sckCaptureUnhealthy.Store(restore) })

	t.Run("login window keeps the single-attempt default", func(t *testing.T) {
		sckCaptureUnhealthy.Store(false)
		plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "login_window"})
		if plan.fallback != nil || plan.primary.name != "platform" || plan.primaryAttempts != 1 {
			t.Fatalf("login_window plan = %+v, want the default single attempt", plan)
		}
	})

	t.Run("latched SCK failure skips ScreenCaptureKit", func(t *testing.T) {
		sckCaptureUnhealthy.Store(true)
		plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "user_session"})
		if plan.fallback != nil || plan.primary.name != "platform" {
			t.Fatalf("latched plan = %+v, want the default plan (newPlatformCapturer picks CG)", plan)
		}
	})

	t.Run("user session on macOS 14+ probes SCK with a gated CG fallback", func(t *testing.T) {
		if !hasSCScreenshotManager() {
			t.Skip("host is older than macOS 14; SCK plan not used")
		}
		sckCaptureUnhealthy.Store(false)
		plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "user_session"})
		if plan.primary.name != "screencapturekit" || plan.primaryAttempts != sckProbeAttempts {
			t.Fatalf("primary = %q x%d, want screencapturekit x%d", plan.primary.name, plan.primaryAttempts, sckProbeAttempts)
		}
		if plan.fallback == nil || plan.fallback.name != "coregraphics" {
			t.Fatalf("fallback = %+v, want coregraphics", plan.fallback)
		}
		if plan.allowCaptureFallback == nil {
			t.Fatal("capture-phase fallback must be gated on Screen Recording preflight")
		}
	})

	t.Run("onSuccess latches only after a capture-phase fallback", func(t *testing.T) {
		if !hasSCScreenshotManager() {
			t.Skip("host is older than macOS 14; SCK plan not used")
		}
		sckCaptureUnhealthy.Store(false)
		plan := darwinCaptureProbePlan(CaptureConfig{DesktopContext: "user_session"})
		plan.onSuccess(captureProbeResult{backend: "screencapturekit"})
		if sckCaptureUnhealthy.Load() {
			t.Fatal("latched after an SCK success")
		}
		plan.onSuccess(captureProbeResult{backend: "coregraphics"})
		if sckCaptureUnhealthy.Load() {
			t.Fatal("latched after an init-phase fallback; only capture-phase failures should latch")
		}
		plan.onSuccess(captureProbeResult{backend: "coregraphics", primaryCaptureFailed: true})
		if !sckCaptureUnhealthy.Load() {
			t.Fatal("did not latch after SCK failed to capture and CG succeeded")
		}
	})
}

// The latch must reach streaming sessions, not just the probe: otherwise the
// probe reports CanCapture=true off a CG frame and the session goes straight
// back to the SCK path that cannot capture.
func TestNewPlatformCapturer_HonorsSCKCaptureUnhealthyLatch(t *testing.T) {
	restore := sckCaptureUnhealthy.Load()
	t.Cleanup(func() { sckCaptureUnhealthy.Store(restore) })
	sckCaptureUnhealthy.Store(true)

	capturer, err := newPlatformCapturer(CaptureConfig{DesktopContext: "user_session"})
	if err != nil {
		// CG init only needs an active display list; a headless host has none.
		t.Skipf("CoreGraphics init unavailable on this host: %v", err)
	}
	defer capturer.Close()
	if _, ok := capturer.(*darwinCGCapturer); !ok {
		t.Fatalf("newPlatformCapturer returned %T with the latch set, want *darwinCGCapturer", capturer)
	}
}
