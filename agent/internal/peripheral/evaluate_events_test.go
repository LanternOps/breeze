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

	events := ToEvents(results, EnforcementOutcome{})
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

	events := ToEvents(results, EnforcementOutcome{})
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

	events := ToEvents(results, EnforcementOutcome{})
	ev := events[0]

	if ev.Details["enforcement"] != "alert_only" {
		t.Fatalf("Details.enforcement = %v, want %q", ev.Details["enforcement"], "alert_only")
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

	events := ToEvents(results, EnforcementOutcome{})
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

	events := ToEvents(results, EnforcementOutcome{})
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

	events := ToEvents(results, EnforcementOutcome{})
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
	events := ToEvents(nil, EnforcementOutcome{})
	if len(events) != 0 {
		t.Fatalf("got %d events for nil results, want 0", len(events))
	}

	events = ToEvents([]EvaluationResult{}, EnforcementOutcome{})
	if len(events) != 0 {
		t.Fatalf("got %d events for empty results, want 0", len(events))
	}
}

func TestToEvents_VerifiedBlockReportsBlocked(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No USB", DeviceClass: "storage", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\B"}, Policy: &pol, Action: "block"},
	}
	outcome := EnforcementOutcome{
		GateOutcomes: map[string]EnforceOutcome{"storage": {Mechanism: "usbstor-start", Applied: true, Verified: true}},
		DeviceOutcomes: []DeviceOutcome{
			{InstanceID: "USBSTOR\\B", EnforceOutcome: EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: true}},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].EventType != "blocked" {
		t.Fatalf("expected eventType blocked, got %q", events[0].EventType)
	}
	if events[0].Details["enforcement"] != "blocked" {
		t.Fatalf("expected enforcement=blocked, got %v", events[0].Details["enforcement"])
	}
}

func TestToEvents_UnverifiedBlockFallsBackToAlertOnly(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No USB", DeviceClass: "storage", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\B"}, Policy: &pol, Action: "block"},
	}
	outcome := EnforcementOutcome{
		DeviceOutcomes: []DeviceOutcome{
			{InstanceID: "USBSTOR\\B", EnforceOutcome: EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: false, Detail: "probe failed"}},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("unverified block must report alert_only, got %v", events[0].Details["enforcement"])
	}
	if events[0].Details["probeDetail"] != "probe failed" {
		t.Fatalf("expected probeDetail surfaced, got %v", events[0].Details["probeDetail"])
	}
}

func TestToEvents_BluetoothBlockStillAlertOnly(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No BT", DeviceClass: "bluetooth", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "bluetooth", DeviceClass: "bluetooth", DeviceID: "BTHENUM\\X"}, Policy: &pol, Action: "block"},
	}
	events := ToEvents(results, EnforcementOutcome{})
	if events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("bluetooth block must stay alert_only, got %v", events[0].Details["enforcement"])
	}
}
