package desktop

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

type capturedRecord struct {
	level slog.Level
	msg   string
	attrs map[string]string
}

type captureHandler struct {
	mu      sync.Mutex
	records []capturedRecord
}

func (h *captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *captureHandler) Handle(_ context.Context, r slog.Record) error {
	rec := capturedRecord{level: r.Level, msg: r.Message, attrs: map[string]string{}}
	r.Attrs(func(a slog.Attr) bool {
		rec.attrs[a.Key] = a.Value.String()
		return true
	})
	h.mu.Lock()
	h.records = append(h.records, rec)
	h.mu.Unlock()
	return nil
}
func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *captureHandler) WithGroup(string) slog.Handler      { return h }

func withCapturedSlog(t *testing.T) *captureHandler {
	t.Helper()
	h := &captureHandler{}
	prev := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return h
}

// #9182: pion logs a TURN Allocate failure at Warn through its own logger,
// which went to stderr (invisible for a service) unless PION_LOG_WARN was set.
func TestPionLogger_WarnRoutesToAgentLog(t *testing.T) {
	h := withCapturedSlog(t)
	SetPionWarnLogging(true)
	t.Cleanup(func() { SetPionWarnLogging(false) })

	l := pionLoggerFactory{}.NewLogger("ice")
	l.Warnf("Failed to create relay candidate: %s", "allocate: 401")

	if len(h.records) != 1 {
		t.Fatalf("want 1 record, got %d", len(h.records))
	}
	r := h.records[0]
	if r.level != slog.LevelWarn {
		t.Fatalf("pion warn with desktop_debug on must log at Warn, got %v", r.level)
	}
	if r.attrs["scope"] != "ice" || !strings.Contains(r.attrs["detail"], "allocate: 401") {
		t.Fatalf("record lost the pion scope/detail: %#v", r)
	}
}

func TestPionLogger_WarnIsDebugWithoutDesktopDebug(t *testing.T) {
	h := withCapturedSlog(t)
	SetPionWarnLogging(false)

	pionLoggerFactory{}.NewLogger("ice").Warn("Failed to ping without candidate pairs")

	if len(h.records) != 1 || h.records[0].level != slog.LevelDebug {
		t.Fatalf("pion warn without desktop_debug must stay at Debug, got %#v", h.records)
	}
}

func TestPionLogger_ErrorAlwaysWarns(t *testing.T) {
	h := withCapturedSlog(t)
	SetPionWarnLogging(false)

	pionLoggerFactory{}.NewLogger("ice").Errorf("Failed to gather relay candidates: %v", "username empty")

	if len(h.records) != 1 || h.records[0].level != slog.LevelWarn {
		t.Fatalf("pion error must always reach the agent log at Warn, got %#v", h.records)
	}
}

func TestPionLogger_InfoAndBelowAreDropped(t *testing.T) {
	h := withCapturedSlog(t)
	SetPionWarnLogging(true)
	t.Cleanup(func() { SetPionWarnLogging(false) })

	l := pionLoggerFactory{}.NewLogger("dtls")
	l.Info("x")
	l.Infof("x %d", 1)
	l.Debug("x")
	l.Debugf("x %d", 1)
	l.Trace("x")
	l.Tracef("x %d", 1)

	if len(h.records) != 0 {
		t.Fatalf("pion info/debug/trace must be dropped, got %#v", h.records)
	}
}

func TestDesktopSettingEngineInstallsPionLogger(t *testing.T) {
	se := newDesktopSettingEngine()
	if _, ok := se.LoggerFactory.(pionLoggerFactory); !ok {
		t.Fatalf("desktop SettingEngine must route pion logs into the agent log, got %T", se.LoggerFactory)
	}
}
