package collectors

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestEventLogStateTransition(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		previous, active        bool
		wantWarn, wantRecovered bool
	}{
		{"healthy", false, false, false, false},
		{"first failure", false, true, true, false},
		{"persistent failure", true, true, false, false},
		{"recovery", true, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			warn, recovered := eventLogStateTransition(tc.previous, tc.active)
			if warn != tc.wantWarn || recovered != tc.wantRecovered {
				t.Fatalf("transition = (%v, %v), want (%v, %v)", warn, recovered, tc.wantWarn, tc.wantRecovered)
			}
		})
	}
}

func TestEventLogStreamStateTransitions(t *testing.T) {
	var states map[string]bool
	for _, tc := range []struct {
		key, name               string
		active, warn, recovered bool
	}{
		{"security", "enter", true, true, false},
		{"security", "repeat", true, false, false},
		{"application-errors", "independent enter", true, true, false},
		{"security", "recover", false, false, true},
		{"security", "healthy", false, false, false},
		{"security", "reenter", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			warn, recovered := updateEventLogStreamState(&states, tc.key, tc.active)
			if warn != tc.warn || recovered != tc.recovered || states[tc.key] != tc.active {
				t.Fatalf("transition = (%v, %v), states=%v", warn, recovered, states)
			}
		})
	}
	if !states["application-errors"] {
		t.Fatal("one stream's recovery cleared another stream's state")
	}
}

func TestWindowsStreamFailureAndFloorStatesRecover(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.categories = []string{"security"}
	c.lastCollectTime = now.Add(-48 * time.Hour)
	for _, tc := range []struct {
		name    string
		err     error
		failing bool
		floored bool
	}{
		{"first failure", errors.New("access denied"), true, true},
		{"repeated failure", errors.New("access denied"), true, true},
		{"query recovers", nil, false, true},
		{"anchor caught up", nil, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return nil, tc.err }, now)
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.failing["security"] != tc.failing || c.floored["security"] != tc.floored {
				t.Fatalf("failing=%v floored=%v", c.failing, c.floored)
			}
		})
	}
}

func TestEventLogCollectorNames(t *testing.T) {
	if got := NewEventLogCollector().name; got != "eventlogs" {
		t.Fatalf("default collector name = %q", got)
	}
	if got := NewReliabilityCollector().eventLogCol.name; got != "reliability" {
		t.Fatalf("reliability collector name = %q", got)
	}
}

func TestWindowsStreamsRunnerPanicIsIsolated(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.categories = []string{"security", "application"}
	old := eventLogBookmark{RecordID: 10, Time: now.Add(-time.Minute)}
	c.bookmarks = map[string]eventLogBookmark{"security": old}
	got := c.collectWindowsStreams(func(logName, xpath string) ([]winEvent, error) {
		if logName == "Security" {
			panic("broken event reader")
		}
		id := int64(21)
		if strings.Contains(xpath, "Provider[") {
			id = 22
		}
		return []winEvent{streamTestEvent(id, now)}, nil
	}, now)
	if len(got) != 2 || got[0].EventID != "1104:21" || got[1].EventID != "1104:22" {
		t.Fatalf("healthy streams did not advance: %+v", got)
	}
	if bookmark := streamTestBookmark(t, c, "security"); bookmark != old || !c.failing["security"] {
		t.Fatalf("panicking stream advanced or was not marked failed: %+v", bookmark)
	}
	if !c.mu.TryLock() {
		t.Fatal("collector mutex remained locked after runner panic")
	}
	c.mu.Unlock()
	if c.IntervalMinutes() != 15 {
		t.Fatal("collector configuration is unusable after panic")
	}
	c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return nil, nil }, now)
	if bookmark := streamTestBookmark(t, c, "security"); bookmark != (eventLogBookmark{RecordID: 10, Time: now}) || c.failing["security"] {
		t.Fatalf("collector did not recover on next pass: %+v", bookmark)
	}
}

type eventLogSnapshotPanicHandler struct{ slog.Handler }

func (h eventLogSnapshotPanicHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Message == "event log backlog floor applied" {
		record.Attrs(func(attr slog.Attr) bool {
			if attr.Key == "collector" && attr.Value.String() == "snapshot-panic-test" {
				panic("snapshot logging failed")
			}
			return true
		})
	}
	return h.Handler.Handle(ctx, record)
}

func TestWindowsStreamSnapshotPanicUnlocksCollector(t *testing.T) {
	logger := slog.Default()
	slog.SetDefault(slog.New(eventLogSnapshotPanicHandler{logger.Handler()}))
	defer slog.SetDefault(logger)
	c := NewEventLogCollector()
	c.name = "snapshot-panic-test"
	c.categories = []string{"security"}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c.lastCollectTime = now.Add(-48 * time.Hour)
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) {
			t.Fatal("runner called after snapshot panic")
			return nil, nil
		}, now)
	}()
	if recovered == nil {
		t.Fatal("snapshot did not exercise panic path")
	}
	if !c.mu.TryLock() {
		t.Fatal("snapshot panic left collector mutex locked")
	}
	c.mu.Unlock()
	if c.IntervalMinutes() != 15 {
		t.Fatal("collector configuration is unusable after snapshot panic")
	}
}
