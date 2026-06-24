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

type fakeEnforcer struct {
	gatesApplied  []string
	gatesReverted []string
	roApplied     []string
	roReverted    []string
	disabled      []string
}

func (f *fakeEnforcer) ApplyGate(class string, hasExceptions bool) EnforceOutcome {
	f.gatesApplied = append(f.gatesApplied, class)
	return EnforceOutcome{Mechanism: "fake-gate", Applied: true, Verified: true}
}
func (f *fakeEnforcer) RevertGate(class string) EnforceOutcome {
	f.gatesReverted = append(f.gatesReverted, class)
	return EnforceOutcome{Mechanism: "fake-gate", Applied: false, Verified: true}
}
func (f *fakeEnforcer) DisableDevice(id string) EnforceOutcome {
	f.disabled = append(f.disabled, id)
	return EnforceOutcome{Mechanism: "fake-disable", Applied: true, Verified: true}
}
func (f *fakeEnforcer) ApplyReadOnly(class string) EnforceOutcome {
	f.roApplied = append(f.roApplied, class)
	return EnforceOutcome{Mechanism: "fake-ro", Applied: true, Verified: true}
}
func (f *fakeEnforcer) RevertReadOnly(class string) EnforceOutcome {
	f.roReverted = append(f.roReverted, class)
	return EnforceOutcome{Mechanism: "fake-ro", Applied: false, Verified: true}
}

func TestEnforce_AppliesAndReverts(t *testing.T) {
	f := &fakeEnforcer{}
	plan := EnforcementPlan{
		BlockGates:         []ClassGate{{Class: "storage", HasExceptions: false}},
		DisableInstanceIDs: []string{"USBSTOR\\B"},
		ReadOnlyClasses:    nil,
	}
	// all enforceable classes; "all_usb" had a block last sync but isn't in this plan -> revert.
	out := Enforce(f, plan, []string{"storage", "all_usb"})

	if len(f.gatesApplied) != 1 || f.gatesApplied[0] != "storage" {
		t.Fatalf("expected storage gate applied, got %+v", f.gatesApplied)
	}
	if len(f.gatesReverted) != 1 || f.gatesReverted[0] != "all_usb" {
		t.Fatalf("expected all_usb gate reverted, got %+v", f.gatesReverted)
	}
	if len(f.disabled) != 1 || f.disabled[0] != "USBSTOR\\B" {
		t.Fatalf("expected device disabled, got %+v", f.disabled)
	}
	// read-only not in plan for either class -> both reverted
	if len(f.roReverted) != 2 {
		t.Fatalf("expected 2 read-only reverts, got %+v", f.roReverted)
	}
	if out.GateOutcomes["storage"].Mechanism != "fake-gate" {
		t.Fatalf("outcome not recorded: %+v", out.GateOutcomes)
	}
}
