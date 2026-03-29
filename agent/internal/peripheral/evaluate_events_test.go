package peripheral

import (
	"testing"
)

func TestToEventsNoPolicy(t *testing.T) {
	results := []EvaluationResult{
		{
			Peripheral: DetectedPeripheral{
				PeripheralType: "usb",
				Vendor:         "SanDisk",
				Product:        "Ultra",
				SerialNumber:   "SN001",
			},
		},
	}

	events := ToEvents(results)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	ev := events[0]
	if ev.EventType != "connected" {
		t.Fatalf("EventType = %q, want %q", ev.EventType, "connected")
	}
	if ev.PolicyID != "" {
		t.Fatalf("PolicyID = %q, want empty", ev.PolicyID)
	}
	if ev.Vendor != "SanDisk" {
		t.Fatalf("Vendor = %q, want %q", ev.Vendor, "SanDisk")
	}
	if ev.Product != "Ultra" {
		t.Fatalf("Product = %q, want %q", ev.Product, "Ultra")
	}
	if ev.SerialNumber != "SN001" {
		t.Fatalf("SerialNumber = %q, want %q", ev.SerialNumber, "SN001")
	}
	if ev.OccurredAt.IsZero() {
		t.Fatal("OccurredAt should not be zero")
	}
	if ev.EventID == "" {
		t.Fatal("EventID should be set")
	}
}

func TestToEventsWithBlockPolicy(t *testing.T) {
	pol := Policy{
		ID:     "pol-block",
		Name:   "Block storage",
		Action: "block",
	}
	results := []EvaluationResult{
		{
			Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage"},
			Policy:     &pol,
			Action:     "block",
		},
	}

	events := ToEvents(results)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}

	ev := events[0]
	if ev.PolicyID != "pol-block" {
		t.Fatalf("PolicyID = %q, want %q", ev.PolicyID, "pol-block")
	}

	if ev.Details["policyName"] != "Block storage" {
		t.Fatalf("Details.policyName = %v, want %q", ev.Details["policyName"], "Block storage")
	}
	if ev.Details["policyAction"] != "block" {
		t.Fatalf("Details.policyAction = %v, want %q", ev.Details["policyAction"], "block")
	}
	if ev.Details["enforcement"] != "alert_only" {
		t.Fatalf("Details.enforcement = %v, want %q", ev.Details["enforcement"], "alert_only")
	}
	if ev.Details["excepted"] != false {
		t.Fatalf("Details.excepted = %v, want false", ev.Details["excepted"])
	}
}

func TestToEventsWithReadOnlyPolicy(t *testing.T) {
	pol := Policy{
		ID:     "pol-ro",
		Name:   "Read-only storage",
		Action: "read_only",
	}
	results := []EvaluationResult{
		{
			Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage"},
			Policy:     &pol,
			Action:     "read_only",
		},
	}

	events := ToEvents(results)
	ev := events[0]

	if ev.Details["enforcement"] != "alert_only" {
		t.Fatalf("Details.enforcement = %v, want %q", ev.Details["enforcement"], "alert_only")
	}
	if ev.Details["note"] == nil {
		t.Fatal("Details.note should be set for read_only action")
	}
}

func TestToEventsWithAllowPolicy(t *testing.T) {
	pol := Policy{
		ID:     "pol-allow",
		Name:   "Allow storage",
		Action: "allow",
	}
	results := []EvaluationResult{
		{
			Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage"},
			Policy:     &pol,
			Action:     "allow",
		},
	}

	events := ToEvents(results)
	ev := events[0]

	// Allow action should NOT have enforcement details
	if _, ok := ev.Details["enforcement"]; ok {
		t.Fatal("allow action should not have enforcement detail")
	}
}

func TestToEventsWithExceptedResult(t *testing.T) {
	pol := Policy{
		ID:     "pol-block",
		Name:   "Block storage",
		Action: "block",
	}
	results := []EvaluationResult{
		{
			Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage"},
			Policy:     &pol,
			Action:     "allow",
			Excepted:   true,
		},
	}

	events := ToEvents(results)
	ev := events[0]

	if ev.Details["excepted"] != true {
		t.Fatalf("Details.excepted = %v, want true", ev.Details["excepted"])
	}
}

func TestToEventsMultiple(t *testing.T) {
	pol := Policy{ID: "p1", Name: "Block", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", Vendor: "A"}},
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", Vendor: "B"}, Policy: &pol, Action: "block"},
		{Peripheral: DetectedPeripheral{PeripheralType: "bluetooth", Vendor: "C"}},
	}

	events := ToEvents(results)
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}

	// Verify unique event IDs
	seen := map[string]bool{}
	for _, ev := range events {
		if seen[ev.EventID] {
			t.Fatalf("duplicate EventID: %s", ev.EventID)
		}
		seen[ev.EventID] = true
	}
}

func TestToEventsEmpty(t *testing.T) {
	events := ToEvents(nil)
	if len(events) != 0 {
		t.Fatalf("got %d events for nil results, want 0", len(events))
	}

	events = ToEvents([]EvaluationResult{})
	if len(events) != 0 {
		t.Fatalf("got %d events for empty results, want 0", len(events))
	}
}
