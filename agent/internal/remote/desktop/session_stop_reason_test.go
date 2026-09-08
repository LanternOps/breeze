package desktop

import (
	"fmt"
	"strings"
	"testing"
)

// These tests cover #5300: the no-video watchdog used to call Session.Stop()
// with no reason and never read LastCaptureError(), so a mid-session capture
// failure reached the viewer as the generic "This remote session has ended"
// text while the startup probe path (#5284/#5295) showed the real Win32
// error. StopWithReason gives teardown the same diagnostic channel the probe
// path already has, reusing the lastCaptureErrorReporter shim #5295
// introduced (reportingCapturer, stubCapturer, gdiCallError, errnoForTest —
// all defined in capture_failure_detail_test.go, same package).

func newTestSession(id string) *Session {
	return &Session{
		id:       id,
		done:     make(chan struct{}),
		isActive: true,
		metrics:  newStreamMetrics(),
	}
}

func TestStopWithReason_RecordsReason(t *testing.T) {
	s := newTestSession("session-1")
	s.StopWithReason("GetDIBits failed: Win32 error 87 (0x57)")

	if got := s.LastStopReason(); got != "GetDIBits failed: Win32 error 87 (0x57)" {
		t.Errorf("LastStopReason() = %q, want the recorded reason", got)
	}
}

func TestStop_LeavesReasonEmpty(t *testing.T) {
	// Existing zero-arg call sites (operator-initiated stop, lifetime policy,
	// etc.) must keep compiling and keep falling back to the generic
	// ended-session text — i.e. Stop() must record no reason at all.
	s := newTestSession("session-1")
	s.Stop()

	if got := s.LastStopReason(); got != "" {
		t.Errorf("LastStopReason() after plain Stop() = %q, want empty", got)
	}
}

func TestStopWithReason_IdempotentWithStopOnce(t *testing.T) {
	// stopOnce guards teardown; a reason passed to a StopWithReason call that
	// loses the race with a concurrent Stop() must not panic or deadlock, and
	// the recorded reason is whichever call actually ran the teardown body.
	s := newTestSession("session-1")
	s.StopWithReason("first")
	s.StopWithReason("second")

	if got := s.LastStopReason(); got != "first" {
		t.Errorf("LastStopReason() = %q, want %q (first Stop wins via stopOnce)", got, "first")
	}
}

func TestStopWithReason_TruncatesOverlongReason(t *testing.T) {
	s := newTestSession("session-1")
	huge := strings.Repeat("x", maxStopReasonBytes*3)
	s.StopWithReason(huge)

	got := s.LastStopReason()
	if len(got) > maxStopReasonBytes {
		t.Errorf("LastStopReason() length = %d, want <= %d (bounded, no handles)", len(got), maxStopReasonBytes)
	}
}

func TestNoVideoStopReason_UsesSwallowedCaptureError(t *testing.T) {
	capturer := &reportingCapturer{lastErr: gdiCallError("GetDIBits", errnoForTest(87))}

	got := noVideoStopReason(capturer)

	if !strings.Contains(got, "GetDIBits failed") {
		t.Errorf("noVideoStopReason() = %q, want it to contain the swallowed GDI error", got)
	}
	if !strings.Contains(got, "87") {
		t.Errorf("noVideoStopReason() = %q, want the Win32 error code", got)
	}
}

func TestNoVideoStopReason_FallsBackWhenNothingSwallowed(t *testing.T) {
	cases := []struct {
		name     string
		capturer ScreenCapturer
	}{
		{"reporter with nil last error", &reportingCapturer{lastErr: nil}},
		{"capturer without the optional interface", &stubCapturer{}},
		{"nil capturer", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := noVideoStopReason(tc.capturer)
			if got != noVideoStopReasonFallback {
				t.Errorf("noVideoStopReason() = %q, want fallback %q", got, noVideoStopReasonFallback)
			}
		})
	}
}

// The technician-facing reason must stay readable — no OS handle values, the
// same bar describeCaptureFailure holds the startup path to (#5284).
func TestNoVideoStopReason_StaysHandleFree(t *testing.T) {
	got := noVideoStopReason(&reportingCapturer{lastErr: gdiCallError("GetDIBits", errnoForTest(5))})
	for _, banned := range []string{"0x0000", "hdc", "HDC", "hBitmap", "memDC"} {
		if strings.Contains(got, banned) {
			t.Errorf("noVideoStopReason() leaks handle detail %q: %q", banned, got)
		}
	}
	if n := len(got); n > 400 {
		t.Errorf("noVideoStopReason() is %d bytes, too long to read: %q", n, got)
	}
}

func TestNoVideoStopReason_WiredThroughToSession(t *testing.T) {
	// End-to-end within the package: what the watchdog would actually record
	// on the session it stops.
	s := newTestSession("session-1")
	capturer := &reportingCapturer{lastErr: gdiCallError("GetDIBits", errnoForTest(87))}

	s.StopWithReason(noVideoStopReason(capturer))

	got := s.LastStopReason()
	if !strings.Contains(got, "GetDIBits failed") {
		t.Errorf("session recorded reason %q, want it to contain the swallowed GDI error", got)
	}
}

func TestSwallowedCaptureError_PassThroughCases(t *testing.T) {
	if got := swallowedCaptureError(nil); got != "" {
		t.Errorf("swallowedCaptureError(nil) = %q, want empty", got)
	}
	if got := swallowedCaptureError(&stubCapturer{}); got != "" {
		t.Errorf("swallowedCaptureError(non-reporting capturer) = %q, want empty", got)
	}
	if got := swallowedCaptureError(&reportingCapturer{lastErr: nil}); got != "" {
		t.Errorf("swallowedCaptureError(reporter with nil last error) = %q, want empty", got)
	}
	err := fmt.Errorf("boom")
	if got := swallowedCaptureError(&reportingCapturer{lastErr: err}); got != err.Error() {
		t.Errorf("swallowedCaptureError() = %q, want %q", got, err.Error())
	}
}
