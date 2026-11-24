package observe

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/patching"
)

func surfaceBIOS() BIOSInfo {
	return BIOSInfo{
		SystemManufacturer: "Microsoft Corporation",
		SystemProductName:  "Surface Laptop, 7th Edition",
		SystemSKU:          "Surface_Laptop_7th_Edition_1950",
		SystemFamily:       "Surface",
		BaseBoardProduct:   "Surface Laptop",
		BIOSVersion:        "175.77.235",
		BIOSReleaseDate:    "08/14/2026",
	}
}

func collectSurface(t *testing.T, host Host) Result {
	t.Helper()
	r := Collect(t.Context(), host, Request{Lane: LaneSurface, ObserveLevel: LevelPassive}, "0.131.0")
	mustValid(t, r)
	return r
}

// wuFake is a Windows Update fake with both halves of the real provider. Only
// its Search can be handed to observe: Host has no install or download seam
// (observe_structure_test.go), so Install and Download here exist only to fail
// the test if anything ever reached them.
type wuFake struct {
	t        *testing.T
	updates  []patching.DriverUpdate
	searches int
}

func (f *wuFake) Search(context.Context) ([]patching.DriverUpdate, error) {
	f.searches++
	return f.updates, nil
}

func (f *wuFake) Install(context.Context, []string) []patching.DriverInstallOutcome {
	f.t.Fatal("observe installed an update")
	return nil
}

func (f *wuFake) Download(context.Context, []string) error {
	f.t.Fatal("observe downloaded an update")
	return nil
}

// TestSurfaceObserveSearchOnlyNeverDownloads proves what it can on any OS: the
// collector's only Windows Update call is the search, made once. That nothing
// else is reachable is the structural tests' half: Host carries no install,
// download or write seam, and the package source never names an install or
// download function.
func TestSurfaceObserveSearchOnlyNeverDownloads(t *testing.T) {
	wu := &wuFake{t: t, updates: []patching.DriverUpdate{
		{UpdateID: "9b0f6a43-1c2d-4e5f-8a7b-0c1d2e3f4a5b", Title: "Surface - Firmware - 175.77.235", DriverManufacturer: "Surface", DriverClass: "Firmware", DriverModel: "Surface UEFI"},
	}}
	host := healthyHost(t, surfaceBIOS(), nil)
	host.SearchDriverUpdates = wu.Search
	r := collectSurface(t, host)
	if wu.searches != 1 {
		t.Fatalf("searches = %d, want 1", wu.searches)
	}
	if r.Surface.WindowsUpdate != "ok" || len(r.Surface.Updates) != 1 || r.Surface.Updates[0].LaneWouldSelect != SelectFirmware {
		t.Fatalf("surface = %+v", r.Surface)
	}
}

// TestQualcommDriverRecordedWithLaneVerdict: an ARM64 Surface's silicon-vendor
// driver is recorded as it is, with the shipped filter's verdict (none), beside
// Surface's own driver (driver) and firmware (firmware).
func TestQualcommDriverRecordedWithLaneVerdict(t *testing.T) {
	host := healthyHost(t, surfaceBIOS(), nil)
	host.IsWow64Process2 = func() (uint16, uint16, error) { return 0, machineARM64, nil }
	host.SearchDriverUpdates = func(context.Context) ([]patching.DriverUpdate, error) {
		return []patching.DriverUpdate{
			{UpdateID: "{3C6C3B5E-0D1E-4A3E-9D0A-6F2F8C1B2A11}", Title: "Qualcomm Technologies, Inc. - Extension - 1.0.4207.6100", DriverManufacturer: "Qualcomm Technologies, Inc.", DriverClass: "Extension", DriverModel: "Qualcomm(R) Adreno(TM) Extension"},
			{UpdateID: "11111111-2222-3333-4444-555555555555", Title: "Surface - System - 1.2.3", DriverManufacturer: "Surface", DriverClass: "System", DriverModel: "Surface Serial Hub Driver"},
			{UpdateID: "9b0f6a43-1c2d-4e5f-8a7b-0c1d2e3f4a5b", Title: "Surface - Firmware - 175.77.235", DriverManufacturer: "Surface", DriverClass: "Firmware", DriverModel: "Surface UEFI"},
		}, nil
	}
	r := collectSurface(t, host)
	if r.NativeArch != "arm64" {
		t.Fatalf("nativeArch = %q", r.NativeArch)
	}
	want := map[string]string{
		"3C6C3B5E-0D1E-4A3E-9D0A-6F2F8C1B2A11": SelectNone,
		"11111111-2222-3333-4444-555555555555": SelectDriver,
		"9b0f6a43-1c2d-4e5f-8a7b-0c1d2e3f4a5b": SelectFirmware,
	}
	if len(r.Surface.Updates) != 3 {
		t.Fatalf("updates = %+v", r.Surface.Updates)
	}
	for _, u := range r.Surface.Updates {
		if got := want[u.UpdateID]; got != u.LaneWouldSelect {
			t.Errorf("%s: laneWouldSelect = %q, want %q", u.UpdateID, u.LaneWouldSelect, got)
		}
		if u.DriverProvider != nil {
			t.Errorf("driverProvider is not read; want null, got %q", *u.DriverProvider)
		}
	}
	q := r.Surface.Updates[0]
	if q.DriverManufacturer == nil || *q.DriverManufacturer != "Qualcomm Technologies, Inc." || q.DriverClass == nil || *q.DriverClass != "Extension" {
		t.Fatalf("qualcomm update = %+v", q)
	}
}

func TestExcludeWUDriversPolicyRead(t *testing.T) {
	cases := map[string]struct {
		value   uint64
		present bool
		err     error
		want    PolicyValue
	}{
		"absent":     {want: PolicyValue{State: "absent"}},
		"present 1":  {value: 1, present: true, want: PolicyValue{State: "present", Value: new(int64(1))}},
		"present 0":  {value: 0, present: true, want: PolicyValue{State: "present", Value: new(int64(0))}},
		"unreadable": {err: errFake, want: PolicyValue{State: "unreadable"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			host := healthyHost(t, surfaceBIOS(), nil)
			host.ExcludeWUDriversPolicy = func() (uint64, bool, error) { return c.value, c.present, c.err }
			got := collectSurface(t, host).Surface.ExcludeWUDriversInQU
			if got.State != c.want.State || (got.Value == nil) != (c.want.Value == nil) || (got.Value != nil && *got.Value != *c.want.Value) {
				t.Fatalf("policy = %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestSurfaceServiceDisabledDoesNotSearch(t *testing.T) {
	host := healthyHost(t, surfaceBIOS(), nil)
	host.WindowsUpdateDisabled = func() (bool, error) { return true, nil }
	host.SearchDriverUpdates = func(context.Context) ([]patching.DriverUpdate, error) {
		t.Fatal("searched with the Windows Update service disabled")
		return nil, nil
	}
	r := collectSurface(t, host)
	if r.Surface.WindowsUpdate != "service_disabled" || len(r.Surface.Updates) != 0 {
		t.Fatalf("surface = %+v", r.Surface)
	}
}

func TestSurfaceSearchFailureRecorded(t *testing.T) {
	host := healthyHost(t, surfaceBIOS(), nil)
	host.SearchDriverUpdates = func(context.Context) ([]patching.DriverUpdate, error) { return nil, errFake }
	r := collectSurface(t, host)
	if r.Surface.WindowsUpdate != "failed" || !hasError(r, stepWindowsUpdate, "wu_search_failed") {
		t.Fatalf("surface %+v errors %+v", r.Surface, r.Errors)
	}
}

func TestSurfaceUpdatesCappedAndTruncated(t *testing.T) {
	var found []patching.DriverUpdate
	for i := range 70 {
		found = append(found, patching.DriverUpdate{UpdateID: "id-" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Title: "Intel - Display - 31.0", DriverManufacturer: "Intel Corporation", DriverClass: "Display"})
	}
	host := healthyHost(t, surfaceBIOS(), nil)
	host.SearchDriverUpdates = func(context.Context) ([]patching.DriverUpdate, error) { return found, nil }
	r := collectSurface(t, host)
	if len(r.Surface.Updates) != maxSurfaceUpdates || !r.Truncated {
		t.Fatalf("updates %d truncated %v", len(r.Surface.Updates), r.Truncated)
	}
}
