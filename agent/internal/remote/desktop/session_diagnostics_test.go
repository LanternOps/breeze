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
