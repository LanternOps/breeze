package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

type forwardCollector struct {
	mu      sync.Mutex
	entries []LogEntry
}

func (c *forwardCollector) add(e LogEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, e)
}

func (c *forwardCollector) levels() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.entries))
	for _, e := range c.entries {
		out = append(out, e.Level)
	}
	return out
}

// TestForwarderLevelFilter pins the #9266 contract: a helper with no direct
// shipper forwards only warn+ records to the agent, so a chatty info stream
// never crosses the IPC boundary.
func TestForwarderLevelFilter(t *testing.T) {
	var buf bytes.Buffer
	Init("text", "debug", &buf)
	t.Cleanup(func() {
		SetForwarder(slog.LevelWarn, nil)
		Init("text", "info", nil)
	})

	c := &forwardCollector{}
	SetForwarder(slog.LevelWarn, c.add)

	logger := L("userhelper")
	logger.Debug("debug line")
	logger.Info("info line")
	logger.Warn("warn line", "reason", "toast disabled")
	logger.Error("error line")

	got := c.levels()
	if strings.Join(got, ",") != "warn,error" {
		t.Fatalf("forwarded levels = %v, want [warn error]", got)
	}

	c.mu.Lock()
	warn := c.entries[0]
	c.mu.Unlock()
	if warn.Message != "warn line" {
		t.Errorf("Message = %q, want %q", warn.Message, "warn line")
	}
	if warn.Component != "userhelper" {
		t.Errorf("Component = %q, want %q", warn.Component, "userhelper")
	}
	if warn.Fields["reason"] != "toast disabled" {
		t.Errorf("Fields[reason] = %v, want %q", warn.Fields["reason"], "toast disabled")
	}

	// Local output is unaffected by forwarding.
	for _, want := range []string{"debug line", "info line", "warn line", "error line"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("local log missing %q", want)
		}
	}
}

// TestForwarderAdmitsBelowLocalLevel: a helper whose local level is error
// still forwards its warns. Enabled must consult the forwarder, or slog
// discards the record before Handle ever runs.
func TestForwarderAdmitsBelowLocalLevel(t *testing.T) {
	var buf bytes.Buffer
	Init("text", "error", &buf)
	t.Cleanup(func() {
		SetForwarder(slog.LevelWarn, nil)
		Init("text", "info", nil)
	})

	c := &forwardCollector{}
	SetForwarder(slog.LevelWarn, c.add)

	slog.Warn("quiet locally")

	if got := c.levels(); len(got) != 1 || got[0] != "warn" {
		t.Fatalf("forwarded levels = %v, want [warn]", got)
	}
	if strings.Contains(buf.String(), "quiet locally") {
		t.Fatal("a record admitted only for forwarding leaked into the local log")
	}
}

// TestForwarderCleared: SetForwarder with a nil func stops forwarding.
func TestForwarderCleared(t *testing.T) {
	Init("text", "info", &bytes.Buffer{})
	t.Cleanup(func() { Init("text", "info", nil) })

	c := &forwardCollector{}
	SetForwarder(slog.LevelWarn, c.add)
	SetForwarder(slog.LevelWarn, nil)

	slog.Error("after clear")
	if got := c.levels(); len(got) != 0 {
		t.Fatalf("forwarded after clear: %v", got)
	}
}
