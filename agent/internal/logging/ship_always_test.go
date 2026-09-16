package logging

import (
	"bytes"
	"log/slog"
	"testing"
)

// installTestShipper swaps the global shipper for the test's lifetime and
// returns it so the test can observe what was shipped.
func installTestShipper(t *testing.T, minLevel slog.Level) *Shipper {
	t.Helper()
	shipper := &Shipper{
		buffer:       make(chan LogEntry, 4),
		minLevel:     minLevel,
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
	return shipper
}

// The desktop-helper ships at log_shipping_level=warn by default, so an
// Info-level record is normally never shipped. A record carrying ShipAlways()
// must bypass that floor (#5929) — and the marker itself must not leak into
// the shipped fields.
func TestShippingHandlerShipAlwaysBypassesMinLevel(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}
	shipper := installTestShipper(t, slog.LevelWarn)

	logger := slog.New(handler)
	logger.Info("Desktop WebRTC metrics", "session", "s1", ShipAlways())

	select {
	case entry := <-shipper.buffer:
		if entry.Level != "info" {
			t.Fatalf("expected info entry, got %q", entry.Level)
		}
		if got := entry.Fields["session"]; got != "s1" {
			t.Fatalf("expected session field, got %#v", got)
		}
		if _, leaked := entry.Fields[KeyShipAlways]; leaked {
			t.Fatalf("ship-always marker leaked into shipped fields: %#v", entry.Fields)
		}
	default:
		t.Fatal("expected ship-always info record to be shipped below min level")
	}
	if !bytes.Contains(buf.Bytes(), []byte("Desktop WebRTC metrics")) {
		t.Fatal("expected record to still reach the local handler")
	}
	if bytes.Contains(buf.Bytes(), []byte(KeyShipAlways)) {
		t.Fatalf("marker must not appear in local output: %s", buf.String())
	}
}

func TestShippingHandlerShipAlwaysOnLoggerAttrs(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}
	shipper := installTestShipper(t, slog.LevelWarn)

	logger := slog.New(handler).With(ShipAlways())
	logger.Info("Viewer WebRTC stats", "rttMs", 12)

	select {
	case entry := <-shipper.buffer:
		if _, leaked := entry.Fields[KeyShipAlways]; leaked {
			t.Fatalf("ship-always marker leaked into shipped fields: %#v", entry.Fields)
		}
		if got := entry.Fields["rttMs"]; got != int64(12) {
			t.Fatalf("expected rttMs field, got %#v", got)
		}
	default:
		t.Fatal("expected ship-always logger attr to ship the record")
	}
	if bytes.Contains(buf.Bytes(), []byte(KeyShipAlways)) {
		t.Fatalf("marker must not appear in local output: %s", buf.String())
	}
}

func TestShippingHandlerInfoWithoutMarkerStillRespectsMinLevel(t *testing.T) {
	handler := &shippingHandler{
		base: slog.NewTextHandler(&bytes.Buffer{}, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}
	shipper := installTestShipper(t, slog.LevelWarn)

	slog.New(handler).Info("ordinary info line", "k", "v")

	select {
	case entry := <-shipper.buffer:
		t.Fatalf("info record below min level must not ship, got %+v", entry)
	default:
	}
}

// A ShipAlways record must not sneak into the shipper when no shipper is
// installed at all (the helper without AgentID/ServerURL/HelperAuthToken).
func TestShippingHandlerShipAlwaysNoShipperIsNoop(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}),
	}
	shipperMu.Lock()
	prev := globalShipper
	globalShipper = nil
	shipperMu.Unlock()
	t.Cleanup(func() {
		shipperMu.Lock()
		globalShipper = prev
		shipperMu.Unlock()
	})

	slog.New(handler).Info("Desktop WebRTC metrics", ShipAlways())
	if !bytes.Contains(buf.Bytes(), []byte("Desktop WebRTC metrics")) {
		t.Fatal("expected record to reach the local handler without a shipper")
	}
}
