package peripheral

import (
	"testing"
)

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
