//go:build darwin && cgo

package desktop

import "testing"

// The ScreenCaptureKit stream configuration must follow the display's size
// across a stream rebuild (#11754). The lab found the rebuild after a mode
// change kept the session's starting output size: SCK scaled a 1280x720 mode
// into 1920x1080 frames, so the session never saw a size change and input kept
// mapping against 1920x1080.
//
// These tests run the real init and rebuild code against a stand-in display
// source, so no SCShareableContent query (and no consent dialog) happens. They
// need the SCStreamConfiguration class, which loads without any permission.

func withFakeSCKDisplay(t *testing.T, pointW, pointH float64) {
	t.Helper()
	if !hasSCScreenshotManager() {
		t.Skip("the ScreenCaptureKit capturer requires macOS 14+")
	}
	darwinCaptureMu.Lock()
	sckUseFakeDisplaySourceForTest(pointW, pointH)
	t.Cleanup(func() {
		sckReleaseCaptureForTest()
		sckUseRealDisplaySourceForTest()
		darwinCaptureMu.Unlock()
	})
}

func TestSCKStreamRebuildFollowsDisplaySize(t *testing.T) {
	withFakeSCKDisplay(t, 1920, 1080)

	if rc := sckInitCaptureForTest(0); rc != 0 {
		// On macOS 14+ the SCK classes must load; a failure here is a real
		// break, not a reason to skip.
		t.Fatalf("initCapture = %d, want 0", rc)
	}
	if w, h := sckOutputConfigSizeForTest(); w != 1920 || h != 1080 {
		t.Fatalf("output after init = %dx%d, want 1920x1080", w, h)
	}

	// The display mode changes; the stream controller restarts the stream,
	// which rebuilds the filter.
	sckUseFakeDisplaySourceForTest(1280, 720)
	if rc := sckRefreshFilterForTest(0); rc != 0 {
		t.Fatalf("filter rebuild = %d, want 0", rc)
	}
	if w, h := sckOutputConfigSizeForTest(); w != 1280 || h != 720 {
		t.Fatalf("output after a rebuild for a 1280x720 display = %dx%d, want 1280x720", w, h)
	}
}

func TestSCKStreamRebuildKeepsSizeWhenDisplayReportsNone(t *testing.T) {
	withFakeSCKDisplay(t, 1440, 900)
	if rc := sckInitCaptureForTest(0); rc != 0 {
		t.Fatalf("initCapture = %d, want 0", rc)
	}

	// A display caught mid-change can report no size. The stream keeps its
	// previous size rather than installing a 0x0 configuration.
	sckUseFakeDisplaySourceForTest(0, 0)
	if rc := sckRefreshFilterForTest(0); rc != 0 {
		t.Fatalf("filter rebuild = %d, want 0 (keep the previous configuration)", rc)
	}
	if w, h := sckOutputConfigSizeForTest(); w != 1440 || h != 900 {
		t.Fatalf("output after a rebuild for a sizeless display = %dx%d, want 1440x900", w, h)
	}
}

func TestSCKInitFailsWhenDisplayReportsNoSize(t *testing.T) {
	withFakeSCKDisplay(t, 0, 0)
	if rc := sckInitCaptureForTest(0); rc == 0 {
		t.Fatal("initCapture succeeded for a display with no size; there is no configuration to fall back on")
	}
}

func TestSCKScaleFromMode(t *testing.T) {
	if !hasSCScreenshotManager() {
		t.Skip("the ScreenCaptureKit capturer requires macOS 14+")
	}
	cases := []struct {
		name                string
		pixelW, pointW      uint
		fallback, wantScale float64
	}{
		{"native 1x mode", 1920, 1920, 2, 1},
		{"HiDPI mode, e.g. a 4K panel looking like 1920x1080", 3840, 1920, 1, 2},
		{"scaled Retina mode (More Space)", 3600, 1800, 1, 2},
		{"mode unknown: NSScreen backing scale", 0, 0, 2, 2},
		{"mode without a point width", 3840, 0, 2, 2},
		{"mode unknown and no screen scale", 0, 0, 0, 1},
	}
	for _, tc := range cases {
		if got := sckScaleFromModeForTest(tc.pixelW, tc.pointW, tc.fallback); got != tc.wantScale {
			t.Errorf("%s: scale(%d px, %d pt, fallback %v) = %v, want %v",
				tc.name, tc.pixelW, tc.pointW, tc.fallback, got, tc.wantScale)
		}
	}
}
