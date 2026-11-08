package desktop

import (
	"context"
	"log/slog"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// diagRecordingHandler captures every record so a test can inspect the attrs the
// production call sites actually attach.
type diagRecordingHandler struct {
	records []slog.Record
}

func (h *diagRecordingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *diagRecordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.records = append(h.records, r)
	return nil
}
func (h *diagRecordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *diagRecordingHandler) WithGroup(string) slog.Handler      { return h }

func installRecordingLogger(t *testing.T) *diagRecordingHandler {
	t.Helper()
	h := &diagRecordingHandler{}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return h
}

func (h *diagRecordingHandler) find(msg string) (slog.Record, bool) {
	for _, r := range h.records {
		if r.Message == msg {
			return r, true
		}
	}
	return slog.Record{}, false
}

func attrKeys(r slog.Record) map[string]slog.Value {
	out := map[string]slog.Value{}
	r.Attrs(func(a slog.Attr) bool {
		out[a.Key] = a.Value
		return true
	})
	return out
}

// The two per-session WebRTC diagnostics are the whole point of #5929: both
// must carry the ShipAlways marker so they reach Agent Logs at the default
// log_shipping_level=warn. Dropping the attr from either line would silently
// revert the fix, so pin it at the call sites.
func TestDesktopWebRTCMetricsLineCarriesShipAlwaysAndTimings(t *testing.T) {
	h := installRecordingLogger(t)
	s := &Session{id: "sess-1", metrics: newStreamMetrics()}

	s.logMetricsSnapshot()

	r, ok := h.find("Desktop WebRTC metrics")
	if !ok {
		t.Fatal("expected Desktop WebRTC metrics line")
	}
	keys := attrKeys(r)
	if v, ok := keys[logging.KeyShipAlways]; !ok || !v.Bool() {
		t.Fatalf("metrics line must carry ShipAlways, got attrs %v", keys)
	}
	for _, k := range []string{"captureMs", "convertMs", "encodeMs", "session"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("metrics line missing %q, got attrs %v", k, keys)
		}
	}
}

func TestViewerWebRTCStatsLineCarriesShipAlways(t *testing.T) {
	h := installRecordingLogger(t)
	s := &Session{id: "sess-1"}

	s.handleControlMessage([]byte(`{"type":"viewer_stats","rttMs":12,"jitterMs":3,"packetsLostDelta":1,"packetsReceivedDelta":99}`))

	r, ok := h.find("Viewer WebRTC stats")
	if !ok {
		t.Fatal("expected Viewer WebRTC stats line")
	}
	keys := attrKeys(r)
	if v, ok := keys[logging.KeyShipAlways]; !ok || !v.Bool() {
		t.Fatalf("viewer stats line must carry ShipAlways, got attrs %v", keys)
	}
	if got := keys["rttMs"].Int64(); got != 12 {
		t.Fatalf("rttMs = %d, want 12", got)
	}
}

// warningCapturer implements the optional captureWarningReporter.
type warningCapturer struct {
	stubCapturer
	warning error
}

func (w *warningCapturer) CaptureWarning() error { return w.warning }

// Frames the GDI capturer delivered without confirming the input desktop may
// be black or show the wrong desktop (#8434 review). They are not a capture
// failure, so they stay out of LastCaptureError (the no-video stop reason and
// the startup probe read that), and are reported on the periodic metrics line
// instead, which ships at the default log level while the session runs.
func TestDesktopWebRTCMetricsLineCarriesCaptureWarning(t *testing.T) {
	warning := &unverifiedInputDesktopError{frames: 3, cause: gdiCallError("OpenInputDesktop", errnoForTest(5))}
	h := installRecordingLogger(t)
	s := &Session{id: "sess-1", metrics: newStreamMetrics(), capturer: &warningCapturer{warning: warning}}

	s.logMetricsSnapshot()

	r, ok := h.find("Desktop WebRTC metrics")
	if !ok {
		t.Fatal("expected Desktop WebRTC metrics line")
	}
	v, ok := attrKeys(r)["captureWarning"]
	if !ok {
		t.Fatalf("metrics line has no captureWarning while the capturer reports one; attrs %v", attrKeys(r))
	}
	if got := v.String(); got != warning.Error() {
		t.Fatalf("captureWarning = %q, want %q", got, warning.Error())
	}

	for name, capturer := range map[string]ScreenCapturer{
		"nil capturer":         nil,
		"capturer without one": &stubCapturer{},
		"no current warning":   &warningCapturer{},
	} {
		h := installRecordingLogger(t)
		s := &Session{id: "sess-1", metrics: newStreamMetrics(), capturer: capturer}
		s.logMetricsSnapshot()
		r, ok := h.find("Desktop WebRTC metrics")
		if !ok {
			t.Fatalf("%s: expected Desktop WebRTC metrics line", name)
		}
		if _, ok := attrKeys(r)["captureWarning"]; ok {
			t.Errorf("%s: metrics line carries captureWarning with nothing to report", name)
		}
	}
}
