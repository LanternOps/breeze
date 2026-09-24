package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestStopShipperDoesNotBlockShutdownLogging(t *testing.T) {
	// Hold the flush open just as an in-flight HTTP request would, without
	// making a real network request or waiting for its 30-second timeout.
	shipper := &Shipper{stopChan: make(chan struct{})}
	shipper.wg.Add(1)
	shipperMu.Lock()
	prev := globalShipper
	globalShipper = shipper
	shipperMu.Unlock()

	stopped := make(chan struct{})
	logged := make(chan struct{})
	var buf bytes.Buffer
	logger := slog.New(&shippingHandler{base: slog.NewTextHandler(&buf, nil)})
	go func() {
		StopShipper()
		close(stopped)
	}()
	<-shipper.stopChan
	t.Cleanup(func() {
		shipper.wg.Done()
		<-stopped
		<-logged
		shipperMu.Lock()
		globalShipper = prev
		shipperMu.Unlock()
	})
	go func() {
		logger.Warn("shutdown stage timed out, continuing")
		close(logged)
	}()
	select {
	case <-logged:
		if !strings.Contains(buf.String(), "shutdown stage timed out") {
			t.Fatal("shutdown warning was not written locally")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown timeout warning blocked behind the shipper flush")
	}
}

func TestPreInitLoggerUsesConfiguredHandler(t *testing.T) {
	logger := L("websocket")

	var buf bytes.Buffer
	Init("text", "info", &buf)

	logger.Info("connected", "server", "http://localhost:3001")

	out := buf.String()
	if strings.Contains(out, `msg="INFO connected`) {
		t.Fatalf("unexpected nested severity prefix in message: %s", out)
	}
	if !strings.Contains(out, "msg=connected") {
		t.Fatalf("expected plain connected message, got: %s", out)
	}
	if !strings.Contains(out, "component=websocket") {
		t.Fatalf("expected component field, got: %s", out)
	}
	if !strings.Contains(out, "server=http://localhost:3001") {
		t.Fatalf("expected server field, got: %s", out)
	}
}

func TestPreInitLoggerRespectsConfiguredLevel(t *testing.T) {
	logger := L("websocket")

	var buf bytes.Buffer
	Init("text", "warn", &buf)

	logger.Info("hidden")
	logger.Warn("shown")

	out := buf.String()
	if strings.Contains(out, "hidden") {
		t.Fatalf("info log should be filtered at warn level: %s", out)
	}
	if !strings.Contains(out, "shown") {
		t.Fatalf("warn log should be emitted: %s", out)
	}
}

func TestShippingHandlerIncludesLoggerAttrs(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}

	shipper := &Shipper{
		buffer:       make(chan LogEntry, 1),
		minLevel:     slog.LevelDebug,
		agentVersion: "1.2.3",
	}

	shipperMu.Lock()
	prev := globalShipper
	globalShipper = shipper
	shipperMu.Unlock()
	t.Cleanup(func() {
		shipperMu.Lock()
		globalShipper = prev
		shipperMu.Unlock()
	})

	logger := slog.New(handler).With(
		slog.String(KeyComponent, "heartbeat"),
		slog.String("subsystem", "poller"),
	)
	logger.Info("test shipping attrs", slog.String("requestId", "req-1"))

	select {
	case entry := <-shipper.buffer:
		if entry.Component != "heartbeat" {
			t.Fatalf("expected component from logger attrs, got %q", entry.Component)
		}
		if got := entry.Fields["subsystem"]; got != "poller" {
			t.Fatalf("expected subsystem field, got %#v", got)
		}
		if got := entry.Fields["requestId"]; got != "req-1" {
			t.Fatalf("expected requestId field, got %#v", got)
		}
	default:
		t.Fatal("expected shipped log entry")
	}
}

type nilPtrError struct{ msg string }

func (e *nilPtrError) Error() string { return e.msg }

func TestShippingHandlerShipsErrorText(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}
	shipper := &Shipper{
		buffer:       make(chan LogEntry, 1),
		minLevel:     slog.LevelDebug,
		agentVersion: "1.2.3",
	}
	shipperMu.Lock()
	prev := globalShipper
	globalShipper = shipper
	shipperMu.Unlock()
	t.Cleanup(func() {
		shipperMu.Lock()
		globalShipper = prev
		shipperMu.Unlock()
	})

	var typedNil *nilPtrError
	joined := errors.Join(errors.New("first"), errors.New("second"))
	slog.New(handler).WithGroup("ctx").Warn("failed",
		"error", errors.New("read /proc/net/route: permission denied"),
		"wrapped", fmt.Errorf("probe: %w", errors.New("timeout")),
		"joined", joined,
		"typedNil", error(typedNil),
		"nilErr", nil,
		"count", 3,
	)

	var entry LogEntry
	select {
	case entry = <-shipper.buffer:
	default:
		t.Fatal("expected shipped log entry")
	}
	want := map[string]any{
		"ctx.error":    "read /proc/net/route: permission denied",
		"ctx.wrapped":  "probe: timeout",
		"ctx.joined":   "first\nsecond",
		"ctx.typedNil": "<nil>",
		"ctx.nilErr":   nil,
		"ctx.count":    int64(3),
	}
	for k, v := range want {
		if got := entry.Fields[k]; got != v {
			t.Fatalf("field %s = %#v, want %#v", k, got, v)
		}
	}

	raw, err := json.Marshal(entry.Fields)
	if err != nil {
		t.Fatalf("marshal fields: %v", err)
	}
	if strings.Contains(string(raw), "{}") {
		t.Fatalf("shipped fields still contain an empty object: %s", raw)
	}
}
