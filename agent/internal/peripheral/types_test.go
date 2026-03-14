package peripheral

import (
	"encoding/json"
	"testing"
	"time"
)

func TestPolicyJSONRoundTrip(t *testing.T) {
	policy := Policy{
		ID:          "pol-123",
		Name:        "Block USB storage",
		DeviceClass: "storage",
		Action:      "block",
		TargetType:  "organization",
		TargetIDs: PolicyTargetIDs{
			SiteIDs:   []string{"site-1"},
			GroupIDs:   []string{"grp-1"},
			DeviceIDs: []string{"dev-a"},
		},
		Exceptions: []ExceptionRule{
			{
				Vendor:       "SanDisk",
				Product:      "Ultra",
				SerialNumber: "SN001",
				Allow:        true,
				Reason:       "approved",
				ExpiresAt:    "2027-12-31T23:59:59Z",
			},
		},
		IsActive:  true,
		UpdatedAt: "2026-03-13T10:00:00Z",
	}

	data, err := json.Marshal(policy)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded Policy
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.ID != policy.ID {
		t.Fatalf("ID = %q, want %q", decoded.ID, policy.ID)
	}
	if decoded.Name != policy.Name {
		t.Fatalf("Name = %q, want %q", decoded.Name, policy.Name)
	}
	if decoded.DeviceClass != policy.DeviceClass {
		t.Fatalf("DeviceClass = %q, want %q", decoded.DeviceClass, policy.DeviceClass)
	}
	if decoded.Action != policy.Action {
		t.Fatalf("Action = %q, want %q", decoded.Action, policy.Action)
	}
	if !decoded.IsActive {
		t.Fatal("IsActive should be true")
	}
	if len(decoded.TargetIDs.SiteIDs) != 1 {
		t.Fatalf("len(SiteIDs) = %d, want 1", len(decoded.TargetIDs.SiteIDs))
	}
	if len(decoded.Exceptions) != 1 {
		t.Fatalf("len(Exceptions) = %d, want 1", len(decoded.Exceptions))
	}
	if decoded.Exceptions[0].Vendor != "SanDisk" {
		t.Fatalf("Exception.Vendor = %q, want %q", decoded.Exceptions[0].Vendor, "SanDisk")
	}
}

func TestPolicyJSONOmitsEmptyFields(t *testing.T) {
	policy := Policy{
		ID:          "pol-minimal",
		DeviceClass: "storage",
		Action:      "allow",
	}

	data, err := json.Marshal(policy)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Verify the JSON does not contain targetIds arrays when empty
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal raw: %v", err)
	}

	// targetIds should be present but sub-fields omitted if empty
	targetRaw, ok := raw["targetIds"]
	if !ok {
		t.Fatal("expected targetIds field in JSON")
	}

	var targetMap map[string]json.RawMessage
	if err := json.Unmarshal(targetRaw, &targetMap); err != nil {
		t.Fatalf("Unmarshal targetIds: %v", err)
	}

	// siteIds, groupIds, deviceIds should all be omitted (omitempty)
	if _, ok := targetMap["siteIds"]; ok {
		t.Fatal("siteIds should be omitted when empty")
	}
	if _, ok := targetMap["groupIds"]; ok {
		t.Fatal("groupIds should be omitted when empty")
	}
	if _, ok := targetMap["deviceIds"]; ok {
		t.Fatal("deviceIds should be omitted when empty")
	}
}

func TestExceptionRuleJSONOmitsEmptyFields(t *testing.T) {
	rule := ExceptionRule{
		Allow: true,
	}

	data, err := json.Marshal(rule)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal raw: %v", err)
	}

	for _, field := range []string{"vendor", "product", "serialNumber", "reason", "expiresAt"} {
		if _, ok := raw[field]; ok {
			t.Fatalf("%s should be omitted when empty", field)
		}
	}

	// allow should be present (no omitempty)
	if _, ok := raw["allow"]; !ok {
		t.Fatal("allow field should always be present")
	}
}

func TestDetectedPeripheralJSONRoundTrip(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		Product:        "Ultra USB 3.0",
		SerialNumber:   "4C530001140902118243",
		DeviceClass:    "storage",
		DeviceID:       "0x0781:0x5583",
	}

	data, err := json.Marshal(dev)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded DetectedPeripheral
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.PeripheralType != dev.PeripheralType {
		t.Fatalf("PeripheralType = %q, want %q", decoded.PeripheralType, dev.PeripheralType)
	}
	if decoded.Vendor != dev.Vendor {
		t.Fatalf("Vendor = %q, want %q", decoded.Vendor, dev.Vendor)
	}
	if decoded.Product != dev.Product {
		t.Fatalf("Product = %q, want %q", decoded.Product, dev.Product)
	}
	if decoded.SerialNumber != dev.SerialNumber {
		t.Fatalf("SerialNumber = %q, want %q", decoded.SerialNumber, dev.SerialNumber)
	}
	if decoded.DeviceClass != dev.DeviceClass {
		t.Fatalf("DeviceClass = %q, want %q", decoded.DeviceClass, dev.DeviceClass)
	}
	if decoded.DeviceID != dev.DeviceID {
		t.Fatalf("DeviceID = %q, want %q", decoded.DeviceID, dev.DeviceID)
	}
}

func TestDetectedPeripheralOmitsEmptyOptional(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		DeviceClass:    "all_usb",
	}

	data, err := json.Marshal(dev)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal raw: %v", err)
	}

	for _, field := range []string{"vendor", "product", "serialNumber", "deviceId"} {
		if _, ok := raw[field]; ok {
			t.Fatalf("%s should be omitted when empty", field)
		}
	}
}

func TestPeripheralEventJSONRoundTrip(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	ev := PeripheralEvent{
		EventID:        "scan-1710000000-0",
		PolicyID:       "pol-1",
		EventType:      "blocked",
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		Product:        "Ultra",
		SerialNumber:   "SN001",
		Details: map[string]any{
			"policyName":   "Block storage",
			"policyAction": "block",
			"excepted":     false,
		},
		OccurredAt: now,
	}

	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded PeripheralEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.EventID != ev.EventID {
		t.Fatalf("EventID = %q, want %q", decoded.EventID, ev.EventID)
	}
	if decoded.PolicyID != ev.PolicyID {
		t.Fatalf("PolicyID = %q, want %q", decoded.PolicyID, ev.PolicyID)
	}
	if decoded.EventType != ev.EventType {
		t.Fatalf("EventType = %q, want %q", decoded.EventType, ev.EventType)
	}
	if decoded.Vendor != ev.Vendor {
		t.Fatalf("Vendor = %q, want %q", decoded.Vendor, ev.Vendor)
	}
}

func TestEventSubmissionJSONStructure(t *testing.T) {
	sub := EventSubmission{
		Events: []PeripheralEvent{
			{EventID: "ev-1", EventType: "connected", PeripheralType: "usb", OccurredAt: time.Now()},
			{EventID: "ev-2", EventType: "blocked", PeripheralType: "usb", OccurredAt: time.Now()},
		},
	}

	data, err := json.Marshal(sub)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded EventSubmission
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if len(decoded.Events) != 2 {
		t.Fatalf("len(Events) = %d, want 2", len(decoded.Events))
	}
	if decoded.Events[0].EventID != "ev-1" {
		t.Fatalf("Events[0].EventID = %q, want %q", decoded.Events[0].EventID, "ev-1")
	}
}

func TestPolicySyncPayloadJSONRoundTrip(t *testing.T) {
	payload := PolicySyncPayload{
		GeneratedAt:      "2026-03-13T10:00:00Z",
		Reason:           "policy_update",
		ChangedPolicyIDs: []string{"pol-1", "pol-2"},
		Policies: []Policy{
			{
				ID:          "pol-1",
				Name:        "Block storage",
				DeviceClass: "storage",
				Action:      "block",
				IsActive:    true,
			},
		},
	}

	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded PolicySyncPayload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.GeneratedAt != payload.GeneratedAt {
		t.Fatalf("GeneratedAt = %q, want %q", decoded.GeneratedAt, payload.GeneratedAt)
	}
	if decoded.Reason != payload.Reason {
		t.Fatalf("Reason = %q, want %q", decoded.Reason, payload.Reason)
	}
	if len(decoded.ChangedPolicyIDs) != 2 {
		t.Fatalf("len(ChangedPolicyIDs) = %d, want 2", len(decoded.ChangedPolicyIDs))
	}
	if len(decoded.Policies) != 1 {
		t.Fatalf("len(Policies) = %d, want 1", len(decoded.Policies))
	}
}
