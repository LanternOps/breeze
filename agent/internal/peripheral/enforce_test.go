package peripheral

import (
	"reflect"
	"testing"
)

func TestPlanEnforcement_BlockNoExceptions(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\DISK&VEN_X\\123"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	want := EnforcementPlan{
		BlockGates:         []ClassGate{{Class: "storage", HasExceptions: false}},
		DisableInstanceIDs: []string{"USBSTOR\\DISK&VEN_X\\123"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan mismatch:\n got=%+v\nwant=%+v", got, want)
	}
}

func TestPlanEnforcement_ExceptedDeviceNotDisabled(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "block", IsActive: true,
		Exceptions: []ExceptionRule{{SerialNumber: "GOOD", Allow: true}}}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\A", SerialNumber: "GOOD"}, Policy: &policies[0], Action: "allow", Excepted: true},
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\B", SerialNumber: "BAD"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	if len(got.DisableInstanceIDs) != 1 || got.DisableInstanceIDs[0] != "USBSTOR\\B" {
		t.Fatalf("expected only USBSTOR\\B disabled, got %+v", got.DisableInstanceIDs)
	}
	if len(got.BlockGates) != 1 || !got.BlockGates[0].HasExceptions {
		t.Fatalf("expected gate flagged HasExceptions, got %+v", got.BlockGates)
	}
}

func TestPlanEnforcement_ReadOnly(t *testing.T) {
	policies := []Policy{{ID: "p1", DeviceClass: "storage", Action: "read_only", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "storage", DeviceID: "USBSTOR\\C"}, Policy: &policies[0], Action: "read_only"},
	}
	got := planEnforcement(results, policies)
	if len(got.ReadOnlyClasses) != 1 || got.ReadOnlyClasses[0] != "storage" {
		t.Fatalf("expected read_only storage, got %+v", got.ReadOnlyClasses)
	}
	if len(got.DisableInstanceIDs) != 0 {
		t.Fatalf("read_only must not disable devices, got %+v", got.DisableInstanceIDs)
	}
}

func TestPlanEnforcement_NonStorageBlockIgnored(t *testing.T) {
	// Bluetooth/thunderbolt block stays alert-only in Tier 1: no plan entries.
	policies := []Policy{{ID: "p1", DeviceClass: "bluetooth", Action: "block", IsActive: true}}
	results := []EvaluationResult{
		{Peripheral: DetectedPeripheral{DeviceClass: "bluetooth", DeviceID: "BTHENUM\\X"}, Policy: &policies[0], Action: "block"},
	}
	got := planEnforcement(results, policies)
	if len(got.BlockGates) != 0 || len(got.DisableInstanceIDs) != 0 {
		t.Fatalf("bluetooth block must produce empty plan, got %+v", got)
	}
}
