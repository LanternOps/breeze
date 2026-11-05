package patching

import (
	"reflect"
	"strconv"
	"testing"
)

func driverIDs(list []DriverUpdate) []string {
	out := make([]string, 0, len(list))
	for _, u := range list {
		out = append(out, u.UpdateID)
	}
	return out
}

func TestDriverSearchCriteria(t *testing.T) {
	if driverSearchCriteria != "Type='Driver' and IsInstalled=0 and IsHidden=0" {
		t.Fatalf("criteria = %q", driverSearchCriteria)
	}
}

func TestSurfaceFilterMatchesSurfaceManufacturer(t *testing.T) {
	cases := []DriverUpdate{
		{DriverManufacturer: "Surface", DriverClass: "System"},
		{DriverManufacturer: "surface", DriverClass: "System"},
		{DriverManufacturer: "  Surface ", DriverClass: "System"},
		{DriverManufacturer: "Microsoft Surface", DriverClass: "System"},
		{DriverManufacturer: "Microsoft", DriverModel: "Surface UEFI", DriverClass: "Firmware"},
		{DriverManufacturer: "Microsoft Corporation", DriverModel: "Surface Laptop 5", DriverClass: "Firmware"},
	}
	for _, u := range cases {
		if !IsSurfaceDriverUpdate(u) {
			t.Errorf("not matched: %+v", u)
		}
	}
}

// Review Focus 1: a near-miss must not authorize a flash on this machine.
func TestNonSurfaceDriverIgnored(t *testing.T) {
	cases := []DriverUpdate{
		{DriverManufacturer: "Intel"},
		{DriverManufacturer: "Intel Corporation", DriverModel: "Surface Dock"},
		{DriverManufacturer: ""},
		{DriverManufacturer: "", DriverModel: "Surface Laptop 5"},
		{DriverManufacturer: "Surface Technologies Inc"},
		{DriverManufacturer: "SurfaceTech"},
		{DriverManufacturer: "Not Surface"},
		{DriverManufacturer: "Microsoft"},
		{DriverManufacturer: "Microsoft", DriverModel: "Hyper-V Virtual Machine"},
		{DriverManufacturer: "Microsoft", DriverModel: "Surfacebook Clone"},
		{DriverManufacturer: "Microsoft", DriverModel: "Not a Surface"},
		{DriverManufacturer: "Microsoft Corporation", DriverModel: ""},
		{DriverManufacturer: "Microsoft Corp Ltd", DriverModel: "Surface Laptop 5"},
	}
	for _, u := range cases {
		if IsSurfaceDriverUpdate(u) {
			t.Errorf("matched: %+v", u)
		}
	}
}

// DriverClass values are UNCONFIRMED until the Surface lab wave (W12, leg S1).
// What these tests pin is the direction of the guess: anything not clearly a
// plain driver takes the firmware path, with all of its gates.
func TestFirmwareClassSplitFromDriver(t *testing.T) {
	cases := []struct {
		name string
		u    DriverUpdate
		kind DriverKind
	}{
		{"class says firmware", DriverUpdate{DriverClass: "Firmware"}, DriverKindFirmware},
		{"class casing", DriverUpdate{DriverClass: "FIRMWARE"}, DriverKindFirmware},
		{"class padded", DriverUpdate{DriverClass: " firmware "}, DriverKindFirmware},
		{"empty class is firmware", DriverUpdate{DriverClass: ""}, DriverKindFirmware},
		{"blank class is firmware", DriverUpdate{DriverClass: "  "}, DriverKindFirmware},
		{"title names firmware under another class", DriverUpdate{DriverClass: "System", Title: "Surface - Firmware - 1.2.3"}, DriverKindFirmware},
		{"model names UEFI under another class", DriverUpdate{DriverClass: "System", DriverModel: "Surface UEFI"}, DriverKindFirmware},
		{"title names UEFI", DriverUpdate{DriverClass: "System", Title: "Surface UEFI update"}, DriverKindFirmware},
		{"system driver", DriverUpdate{DriverClass: "System", Title: "Surface - System - 1.2.3", DriverModel: "Surface Serial Hub"}, DriverKindDriver},
		{"hid driver", DriverUpdate{DriverClass: "HIDClass", Title: "Surface - HIDClass - 2.0"}, DriverKindDriver},
		{"network driver", DriverUpdate{DriverClass: "Net", Title: "Surface - Net - 3.0"}, DriverKindDriver},
	}
	for _, c := range cases {
		if got := ClassifyDriverUpdate(c.u); got != c.kind {
			t.Errorf("%s: got %s, want %s", c.name, got, c.kind)
		}
	}
}

func TestBlockedUpdateIdsDropped(t *testing.T) {
	all := []DriverUpdate{
		{UpdateID: "AAAA-1", DriverManufacturer: "Surface", DriverClass: "System"},
		{UpdateID: "bbbb-2", DriverManufacturer: "Surface", DriverClass: "Firmware"},
		{UpdateID: "cccc-3", DriverManufacturer: "Surface", DriverClass: "Firmware"},
		{UpdateID: "dddd-4", DriverManufacturer: "Surface", DriverClass: "HIDClass"},
		{UpdateID: "eeee-5", DriverManufacturer: "Intel", DriverClass: "Display"},
	}
	plan := SelectSurfaceDriverUpdates(all, []string{"aaaa-1", " {BBBB-2} ", "not-pending", ""})
	if got := driverIDs(plan.Drivers); !reflect.DeepEqual(got, []string{"dddd-4"}) {
		t.Fatalf("drivers = %v", got)
	}
	if got := driverIDs(plan.Firmware); !reflect.DeepEqual(got, []string{"cccc-3"}) {
		t.Fatalf("firmware = %v", got)
	}
}

// An update with no id can be neither blocked nor installed.
func TestUpdateWithNoIdIsDropped(t *testing.T) {
	plan := SelectSurfaceDriverUpdates([]DriverUpdate{{DriverManufacturer: "Surface", DriverClass: "System"}}, nil)
	if len(plan.Drivers) != 0 || len(plan.Firmware) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestSelectionIsBoundedAndDeduplicated(t *testing.T) {
	var all []DriverUpdate
	for i := 0; i < maxDriverUpdates+50; i++ {
		all = append(all, DriverUpdate{UpdateID: "id-" + strconv.Itoa(i), DriverManufacturer: "Surface", DriverClass: "System"})
	}
	all = append(all[:1:1], all...) // the first id twice
	plan := SelectSurfaceDriverUpdates(all, nil)
	if len(plan.Drivers) != maxDriverUpdates {
		t.Fatalf("drivers = %d, want %d", len(plan.Drivers), maxDriverUpdates)
	}
	seen := map[string]bool{}
	for _, u := range plan.Drivers {
		if seen[u.UpdateID] {
			t.Fatalf("%s selected twice", u.UpdateID)
		}
		seen[u.UpdateID] = true
	}
}
