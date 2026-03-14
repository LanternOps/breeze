package peripheral

import (
	"testing"
	"time"
)

func TestFieldMatchesEmpty(t *testing.T) {
	// Empty rule value acts as wildcard — matches anything.
	if !fieldMatches("", "anything") {
		t.Fatal("empty rule should match any device value")
	}
	if !fieldMatches("", "") {
		t.Fatal("empty rule should match empty device value")
	}
}

func TestFieldMatchesExact(t *testing.T) {
	if !fieldMatches("SanDisk", "SanDisk") {
		t.Fatal("exact match should succeed")
	}
}

func TestFieldMatchesCaseInsensitive(t *testing.T) {
	if !fieldMatches("sandisk", "SanDisk") {
		t.Fatal("case-insensitive match should succeed")
	}
	if !fieldMatches("SANDISK", "sandisk") {
		t.Fatal("case-insensitive match should succeed (upper vs lower)")
	}
}

func TestFieldMatchesMismatch(t *testing.T) {
	if fieldMatches("Kingston", "SanDisk") {
		t.Fatal("mismatched values should not match")
	}
}

func TestClassMatchesExact(t *testing.T) {
	tests := []struct {
		policyClass string
		deviceClass string
		want        bool
	}{
		{"storage", "storage", true},
		{"bluetooth", "bluetooth", true},
		{"thunderbolt", "thunderbolt", true},
		{"all_usb", "all_usb", true},
	}
	for _, tt := range tests {
		if got := classMatches(tt.policyClass, tt.deviceClass); got != tt.want {
			t.Fatalf("classMatches(%q, %q) = %v, want %v", tt.policyClass, tt.deviceClass, got, tt.want)
		}
	}
}

func TestClassMatchesAllUSBCoversStorage(t *testing.T) {
	if !classMatches("all_usb", "storage") {
		t.Fatal("all_usb policy should cover storage devices")
	}
	if !classMatches("all_usb", "all_usb") {
		t.Fatal("all_usb policy should cover all_usb devices")
	}
}

func TestClassMatchesDoesNotCrossCover(t *testing.T) {
	// storage policy should NOT cover all_usb devices
	if classMatches("storage", "all_usb") {
		t.Fatal("storage policy should not cover all_usb devices")
	}
	// bluetooth should NOT match storage
	if classMatches("bluetooth", "storage") {
		t.Fatal("bluetooth policy should not cover storage devices")
	}
	// storage should NOT match bluetooth
	if classMatches("storage", "bluetooth") {
		t.Fatal("storage policy should not cover bluetooth devices")
	}
}

func TestMatchesExceptionBasicMatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:  "SanDisk",
		Product: "Ultra",
	}
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, Reason: "approved"},
	}

	matched, ex := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match by vendor")
	}
	if ex.Reason != "approved" {
		t.Fatalf("matched exception reason = %q, want %q", ex.Reason, "approved")
	}
}

func TestMatchesExceptionSerialNumber(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	exceptions := []ExceptionRule{
		{SerialNumber: "ABC123", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match by serial number")
	}
}

func TestMatchesExceptionMultipleFields(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	// All three fields specified and all match
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Product: "Ultra", SerialNumber: "ABC123", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match when all fields match")
	}
}

func TestMatchesExceptionPartialFieldMismatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	// Vendor matches but serial doesn't
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", SerialNumber: "WRONG", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception should not match when serial number mismatches")
	}
}

func TestMatchesExceptionEmptyFieldsSkipped(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:  "SanDisk",
		Product: "Ultra",
	}
	// Exception with no fields specified — should not match
	exceptions := []ExceptionRule{
		{Allow: true, Reason: "blank rule"},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception with no vendor/product/serial should not match")
	}
}

func TestMatchesExceptionAllowFalseDoesNotMatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	// Vendor matches but Allow is false
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: false},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception with Allow=false should not return matched=true")
	}
}

func TestMatchesExceptionExpired(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	pastTime := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: pastTime},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("expired exception should not match")
	}
}

func TestMatchesExceptionNotYetExpired(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	futureTime := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: futureTime},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("non-expired exception should match")
	}
}

func TestMatchesExceptionInvalidExpiryTreatedAsNoExpiry(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	// Invalid date string — parse fails, treated as non-expired
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: "not-a-date"},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception with unparseable expiry should still match (treated as non-expired)")
	}
}

func TestMatchesExceptionNoExceptions(t *testing.T) {
	dev := DetectedPeripheral{Vendor: "SanDisk"}
	matched, _ := matchesException(dev, nil)
	if matched {
		t.Fatal("nil exceptions list should not match")
	}

	matched, _ = matchesException(dev, []ExceptionRule{})
	if matched {
		t.Fatal("empty exceptions list should not match")
	}
}

func TestEvaluateOneNoPolicy(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		DeviceClass:    "storage",
	}

	result := evaluateOne(dev, nil)
	if result.Policy != nil {
		t.Fatal("no policies should yield nil Policy")
	}
	if result.Action != "" {
		t.Fatalf("Action = %q, want empty", result.Action)
	}
	if result.Excepted {
		t.Fatal("Excepted should be false with no policy")
	}
}

func TestEvaluateOneInactivePolicySkipped(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    false,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy != nil {
		t.Fatal("inactive policy should be skipped — expected nil Policy")
	}
}

func TestEvaluateOneClassMismatchSkipped(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-bt",
			DeviceClass: "bluetooth",
			Action:      "block",
			IsActive:    true,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy != nil {
		t.Fatal("policy with mismatched class should be skipped")
	}
}

func TestEvaluateOneFirstMatchWins(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Alert on storage",
			DeviceClass: "storage",
			Action:      "alert",
			IsActive:    true,
		},
		{
			ID:          "pol-2",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy == nil {
		t.Fatal("expected a matching policy")
	}
	if result.Policy.ID != "pol-1" {
		t.Fatalf("Policy.ID = %q, want %q (first match wins)", result.Policy.ID, "pol-1")
	}
	if result.Action != "alert" {
		t.Fatalf("Action = %q, want %q", result.Action, "alert")
	}
}

func TestEvaluateOneWithException(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		Product:        "Ultra",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
			Exceptions: []ExceptionRule{
				{Vendor: "SanDisk", Allow: true, Reason: "IT-approved"},
			},
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy == nil {
		t.Fatal("expected matching policy")
	}
	if !result.Excepted {
		t.Fatal("expected Excepted=true for exception match")
	}
	if result.Action != "allow" {
		t.Fatalf("Action = %q, want %q (exception overrides block)", result.Action, "allow")
	}
}

func TestEvaluateMultiplePeripherals(t *testing.T) {
	peripherals := []DetectedPeripheral{
		{PeripheralType: "usb", Vendor: "SanDisk", DeviceClass: "storage"},
		{PeripheralType: "bluetooth", Vendor: "Apple", DeviceClass: "bluetooth"},
		{PeripheralType: "usb", Vendor: "Logitech", DeviceClass: "all_usb"},
	}
	policies := []Policy{
		{
			ID:          "pol-storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
		},
		{
			ID:          "pol-bt",
			DeviceClass: "bluetooth",
			Action:      "alert",
			IsActive:    true,
		},
	}

	results := Evaluate(peripherals, policies)
	if len(results) != 3 {
		t.Fatalf("got %d results, want 3", len(results))
	}

	// SanDisk storage -> blocked
	if results[0].Action != "block" {
		t.Fatalf("results[0].Action = %q, want %q", results[0].Action, "block")
	}
	// Apple bluetooth -> alert
	if results[1].Action != "alert" {
		t.Fatalf("results[1].Action = %q, want %q", results[1].Action, "alert")
	}
	// Logitech all_usb -> no matching policy
	if results[2].Policy != nil {
		t.Fatal("Logitech all_usb should have no matching policy (storage and bluetooth only)")
	}
}

func TestEvaluateAllUSBPolicyCoversBothStorageAndAllUSB(t *testing.T) {
	peripherals := []DetectedPeripheral{
		{PeripheralType: "usb", Vendor: "SanDisk", DeviceClass: "storage"},
		{PeripheralType: "usb", Vendor: "Logitech", DeviceClass: "all_usb"},
	}
	policies := []Policy{
		{
			ID:          "pol-all-usb",
			DeviceClass: "all_usb",
			Action:      "block",
			IsActive:    true,
		},
	}

	results := Evaluate(peripherals, policies)
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}
	for i, r := range results {
		if r.Action != "block" {
			t.Fatalf("results[%d].Action = %q, want %q", i, r.Action, "block")
		}
	}
}

func TestEvaluateEmptyInputs(t *testing.T) {
	// No peripherals
	results := Evaluate(nil, []Policy{{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true}})
	if len(results) != 0 {
		t.Fatalf("got %d results for nil peripherals, want 0", len(results))
	}

	// No policies
	results = Evaluate([]DetectedPeripheral{{DeviceClass: "storage"}}, nil)
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if results[0].Policy != nil {
		t.Fatal("expected nil policy when no policies provided")
	}
}

func TestPolicyIDHelper(t *testing.T) {
	if id := policyID(nil); id != "" {
		t.Fatalf("policyID(nil) = %q, want empty", id)
	}
	p := &Policy{ID: "pol-123"}
	if id := policyID(p); id != "pol-123" {
		t.Fatalf("policyID(p) = %q, want %q", id, "pol-123")
	}
}

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

// Table-driven test covering the full evaluate+event pipeline.
func TestEvaluateTableDriven(t *testing.T) {
	tests := []struct {
		name       string
		peripheral DetectedPeripheral
		policies   []Policy
		wantAction string
		wantPolicy bool
		excepted   bool
	}{
		{
			name:       "no policies",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies:   nil,
			wantAction: "",
			wantPolicy: false,
		},
		{
			name:       "block matching storage",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true},
			},
			wantAction: "block",
			wantPolicy: true,
		},
		{
			name:       "inactive policy skipped",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: false},
			},
			wantAction: "",
			wantPolicy: false,
		},
		{
			name:       "class mismatch skipped",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "bluetooth", Action: "block", IsActive: true},
			},
			wantAction: "",
			wantPolicy: false,
		},
		{
			name:       "all_usb covers storage",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "all_usb", Action: "alert", IsActive: true},
			},
			wantAction: "alert",
			wantPolicy: true,
		},
		{
			name: "exception overrides block",
			peripheral: DetectedPeripheral{
				DeviceClass: "storage",
				Vendor:      "SanDisk",
			},
			policies: []Policy{
				{
					ID:          "p1",
					DeviceClass: "storage",
					Action:      "block",
					IsActive:    true,
					Exceptions:  []ExceptionRule{{Vendor: "SanDisk", Allow: true}},
				},
			},
			wantAction: "allow",
			wantPolicy: true,
			excepted:   true,
		},
		{
			name: "exception mismatch does not override",
			peripheral: DetectedPeripheral{
				DeviceClass: "storage",
				Vendor:      "Kingston",
			},
			policies: []Policy{
				{
					ID:          "p1",
					DeviceClass: "storage",
					Action:      "block",
					IsActive:    true,
					Exceptions:  []ExceptionRule{{Vendor: "SanDisk", Allow: true}},
				},
			},
			wantAction: "block",
			wantPolicy: true,
			excepted:   false,
		},
		{
			name:       "first matching policy wins",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "storage", Action: "allow", IsActive: true},
				{ID: "p2", DeviceClass: "storage", Action: "block", IsActive: true},
			},
			wantAction: "allow",
			wantPolicy: true,
		},
		{
			name:       "skip inactive then match active",
			peripheral: DetectedPeripheral{DeviceClass: "storage"},
			policies: []Policy{
				{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: false},
				{ID: "p2", DeviceClass: "storage", Action: "alert", IsActive: true},
			},
			wantAction: "alert",
			wantPolicy: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := evaluateOne(tt.peripheral, tt.policies)
			if tt.wantPolicy && result.Policy == nil {
				t.Fatal("expected a matching policy, got nil")
			}
			if !tt.wantPolicy && result.Policy != nil {
				t.Fatalf("expected no matching policy, got %q", result.Policy.ID)
			}
			if result.Action != tt.wantAction {
				t.Fatalf("Action = %q, want %q", result.Action, tt.wantAction)
			}
			if result.Excepted != tt.excepted {
				t.Fatalf("Excepted = %v, want %v", result.Excepted, tt.excepted)
			}
		})
	}
}
