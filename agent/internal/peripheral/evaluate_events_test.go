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

// TestToEvents_ConnectedDeviceGateOnlyNotBlocked locks the fix for the gate
// false-success: a currently-connected device whose per-device disable did NOT
// verify must report alert_only even if the machine-wide gate verified — the
// gate only blocks future insertions, not a live device.
func TestToEvents_ConnectedDeviceGateOnlyNotBlocked(t *testing.T) {
	pol := Policy{ID: "p1", Name: "No USB", DeviceClass: "storage", Action: "block"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\LIVE"}, Policy: &pol, Action: "block"},
	}
	outcome := EnforcementOutcome{
		GateOutcomes: map[string]EnforceOutcome{"storage": {Mechanism: "usbstor-start", Applied: true, Verified: true}},
		DeviceOutcomes: []DeviceOutcome{
			{InstanceID: "USBSTOR\\LIVE", EnforceOutcome: EnforceOutcome{Mechanism: "pnputil", Applied: true, Verified: false, Detail: "remove failed"}},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].EventType != "connected" || events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("connected device with failed per-device disable must be alert_only despite verified gate, got type=%q enf=%v",
			events[0].EventType, events[0].Details["enforcement"])
	}
}

// TestToEvents_AllUsbReadOnlyOnStorageDevice locks the fix for the class-key
// mismatch: an all_usb read_only policy matching a storage device records its
// outcome under "all_usb" (the policy class), and reporting must look it up by
// policy class — not the device class "storage" — or it falsely reports alert_only.
func TestToEvents_AllUsbReadOnlyOnStorageDevice(t *testing.T) {
	pol := Policy{ID: "p1", Name: "RO USB", DeviceClass: "all_usb", Action: "read_only"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\C"}, Policy: &pol, Action: "read_only"},
	}
	outcome := EnforcementOutcome{
		ReadOnlyOutcomes: map[string]EnforceOutcome{
			"all_usb": {Mechanism: "removable-storage-deny-write", Applied: true, Verified: true},
			"storage": {Mechanism: "removable-storage-deny-write", Applied: false, Verified: true}, // reverted sibling
		},
	}
	events := ToEvents(results, outcome)
	if events[0].EventType != "mounted_read_only" || events[0].Details["enforcement"] != "read_only" {
		t.Fatalf("all_usb read_only on storage device must report mounted_read_only, got type=%q enf=%v",
			events[0].EventType, events[0].Details["enforcement"])
	}
}

// TestToEvents_ReadOnlyUnverifiedFallsBackToAlertOnly mirrors the block case:
// a read_only write-deny that was attempted but not probe-confirmed must report
// alert_only (e.g. the 2025 Removable Storage Access servicing regression).
func TestToEvents_ReadOnlyUnverifiedFallsBackToAlertOnly(t *testing.T) {
	pol := Policy{ID: "p1", Name: "RO", DeviceClass: "storage", Action: "read_only"}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{PeripheralType: "usb", DeviceClass: "storage", DeviceID: "USBSTOR\\D"}, Policy: &pol, Action: "read_only"},
	}
	outcome := EnforcementOutcome{
		ReadOnlyOutcomes: map[string]EnforceOutcome{
			"storage": {Mechanism: "removable-storage-deny-write", Applied: true, Verified: false, Detail: "Deny_Write read-back mismatch"},
		},
	}
	events := ToEvents(results, outcome)
	if events[0].EventType != "connected" || events[0].Details["enforcement"] != "alert_only" {
		t.Fatalf("unverified read_only must report alert_only, got type=%q enf=%v",
			events[0].EventType, events[0].Details["enforcement"])
	}
}
