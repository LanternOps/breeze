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
// and mode, so no SCShareableContent query (and no consent dialog) happens.
// They need the SCStreamConfiguration class, which loads without any
// permission.

// mode1x is a native mode: one pixel per point.
func mode1x(w, h float64) sckFakeDisplay {
	return sckFakeDisplay{PointW: w, PointH: h, ModePixelW: uint(w), ModePixelH: uint(h), ModePtW: uint(w)}
}

func withFakeSCKDisplay(t *testing.T, d sckFakeDisplay) {
	t.Helper()
	if !hasSCScreenshotManager() {
		t.Skip("the ScreenCaptureKit capturer requires macOS 14+")
	}
	darwinCaptureMu.Lock()
	sckUseFakeDisplaySourceForTest(d)
	t.Cleanup(func() {
		sckReleaseCaptureForTest()
		sckUseRealDisplaySourceForTest()
		darwinCaptureMu.Unlock()
	})
	if rc := sckInitCaptureForTest(0); rc != 0 {
		// On macOS 14+ the SCK classes must load; a failure here is a real
		// break, not a reason to skip.
		t.Fatalf("initCapture = %d, want 0", rc)
	}
}

func assertSCKOutput(t *testing.T, when string, wantW, wantH int) {
	t.Helper()
	if w, h := sckOutputConfigSizeForTest(); w != wantW || h != wantH {
		t.Fatalf("output %s = %dx%d, want %dx%d", when, w, h, wantW, wantH)
	}
}

func assertSCKModeBaseline(t *testing.T, when string, wantW, wantH int) {
	t.Helper()
	if w, h := sckModeBaselineForTest(); w != wantW || h != wantH {
		t.Fatalf("recorded display mode %s = %dx%d, want %dx%d", when, w, h, wantW, wantH)
	}
}

func rebuildSCKFilter(t *testing.T, d sckFakeDisplay) {
	t.Helper()
	sckUseFakeDisplaySourceForTest(d)
	// The stream controller restarts the stream, which rebuilds the filter.
	if rc := sckRefreshFilterForTest(0); rc != 0 {
		t.Fatalf("filter rebuild = %d, want 0", rc)
	}
}

func TestSCKStreamRebuildFollowsDisplaySize(t *testing.T) {
	withFakeSCKDisplay(t, mode1x(1920, 1080))
	assertSCKOutput(t, "after init", 1920, 1080)
	assertSCKModeBaseline(t, "after init", 1920, 1080)

	rebuildSCKFilter(t, mode1x(1280, 720))
	assertSCKOutput(t, "after a rebuild for a 1280x720 mode", 1280, 720)
	// sckDisplayChanged compares against this; left at 1920x1080 it would
	// rebuild on every poll.
	assertSCKModeBaseline(t, "after a rebuild for a 1280x720 mode", 1280, 720)
}

func TestSCKStreamFollowsBackingScale(t *testing.T) {
	// A HiDPI mode that looks like 1440x900: two pixels per point.
	withFakeSCKDisplay(t, sckFakeDisplay{PointW: 1440, PointH: 900, ModePixelW: 2880, ModePixelH: 1800, ModePtW: 1440})
	assertSCKOutput(t, "for a 2x mode", 2880, 1800)

	// "More Space": looks like 1680x1050, still 2x.
	rebuildSCKFilter(t, sckFakeDisplay{PointW: 1680, PointH: 1050, ModePixelW: 3360, ModePixelH: 2100, ModePtW: 1680})
	assertSCKOutput(t, "after a rebuild for a scaled 2x mode", 3360, 2100)
	assertSCKModeBaseline(t, "after a rebuild for a scaled 2x mode", 3360, 2100)

	// The low-resolution 1x mode of the same panel.
	rebuildSCKFilter(t, mode1x(1440, 900))
	assertSCKOutput(t, "after a rebuild for a 1x mode", 1440, 900)
}

func TestSCKStreamRebuildKeepsOutputWhenDisplayReportsNoSize(t *testing.T) {
	withFakeSCKDisplay(t, mode1x(1440, 900))

	// A display caught mid-change can report no size. The stream keeps its
	// output and its recorded mode: clearing the mode would make every
	// display poll rebuild the stream for as long as the size stays missing.
	rebuildSCKFilter(t, sckFakeDisplay{ModePixelW: 1440, ModePixelH: 900, ModePtW: 1440})
	assertSCKOutput(t, "after a rebuild for a sizeless display", 1440, 900)
	assertSCKModeBaseline(t, "after a rebuild for a sizeless display", 1440, 900)
}

func TestSCKStreamRebuildKeepsOutputWhenModeUnavailable(t *testing.T) {
	withFakeSCKDisplay(t, sckFakeDisplay{PointW: 1440, PointH: 900, ModePixelW: 2880, ModePixelH: 1800, ModePtW: 1440})

	// A display waking can have no mode for a moment. The scale would then
	// come from NSScreen, which may disagree with the mode, and resize the
	// output with no mode change. The rebuild keeps the output instead.
	rebuildSCKFilter(t, sckFakeDisplay{PointW: 1440, PointH: 900})
	assertSCKOutput(t, "after a rebuild with no display mode", 2880, 1800)
	assertSCKModeBaseline(t, "after a rebuild with no display mode", 2880, 1800)
}

func TestSCKInitWithoutModeUsesPointSize(t *testing.T) {
	// The stand-in display is not an NSScreen, so the fallback scale is 1.0.
	withFakeSCKDisplay(t, sckFakeDisplay{PointW: 1280, PointH: 800})
	assertSCKOutput(t, "after init with no display mode", 1280, 800)
}

func TestSCKInitFailsWhenDisplayReportsNoSize(t *testing.T) {
	if !hasSCScreenshotManager() {
		t.Skip("the ScreenCaptureKit capturer requires macOS 14+")
	}
	darwinCaptureMu.Lock()
	sckUseFakeDisplaySourceForTest(sckFakeDisplay{ModePixelW: 1920, ModePixelH: 1080, ModePtW: 1920})
	t.Cleanup(func() {
		sckReleaseCaptureForTest()
		sckUseRealDisplaySourceForTest()
		darwinCaptureMu.Unlock()
	})
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
