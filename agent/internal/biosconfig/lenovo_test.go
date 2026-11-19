package biosconfig

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func lenovoObserve(t *testing.T, f *fakeRunner, model string) *Observation {
	t.Helper()
	o := observer(t, DetectWith("LENOVO", model, VendorLenovo, f.run)).Observe(context.Background())
	if o == nil {
		t.Fatal("nil observation")
	}
	return o
}

func selectionsReply(t *testing.T, results map[string]string, failed ...string) []byte {
	t.Helper()
	rows := []any{}
	for name, sel := range results {
		rows = append(rows, map[string]any{"name": name, "selections": sel, "error": nil})
	}
	for _, name := range failed {
		rows = append(rows, map[string]any{"name": name, "selections": nil, "error": map[string]any{"step": "select", "fqid": "HRESULT 0x80041032,x", "native": ""}})
	}
	return mustJSON(t, map[string]any{"received": len(rows), "results": rows, "error": nil})
}

func TestLenovoCurrentSettingSplit(t *testing.T) {
	cases := []struct {
		in       string
		name     string
		value    string
		optional []string
		ok       bool
	}{
		{"WakeOnLAN,ACOnly", "WakeOnLAN", "ACOnly", nil, true},
		{"WakeOnLAN,ACOnly;[Optional:Disable,ACOnly,ACandBattery,Enable]", "WakeOnLAN", "ACOnly", []string{"Disable", "ACOnly", "ACandBattery", "Enable"}, true},
		{"WakeOnLAN,ACOnly;[Optional:Disable,ACOnly][Status:ShowAndChange]", "WakeOnLAN", "ACOnly", []string{"Disable", "ACOnly"}, true},
		{"AfterPowerLoss,Power Off", "AfterPowerLoss", "Power Off", nil, true},
		{"WakeOnLAN,", "WakeOnLAN", "", nil, true},
		{"WakeOnLAN", "", "", nil, false},
		{",ACOnly", "", "", nil, false},
		{"", "", "", nil, false},
	}
	for _, c := range cases {
		name, value, optional, ok := splitLenovoSetting(c.in)
		if ok != c.ok || name != c.name || value != c.value || !reflect.DeepEqual(optional, c.optional) {
			t.Errorf("split(%q) = %q %q %q %v", c.in, name, value, optional, ok)
		}
	}
}

func TestLenovoReadParsesDocDerived(t *testing.T) {
	f := newFakeRunner()
	f.out[lenovoReadScript] = fixture(t, "lenovo", "doc-derived", "thinkpad.json")
	f.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{
		"WakeOnLAN":           "Disable,ACOnly,ACandBattery,Enable",
		"WakeOnLANDock":       "Disable,Enable",
		"AfterPowerLoss":      "PowerOn,PowerOff,LastState",
		"PXEIPV4NetworkStack": "Disable,Enable",
	})
	o := lenovoObserve(t, f, "20U9CTO1WW")
	if o.Vendor != "lenovo" || o.Interface != InterfacePresent || o.ErrorCode != nil || o.Lenovo == nil {
		t.Fatalf("observation = %+v", o)
	}
	l := o.Lenovo
	want := []string{"WakeOnLAN", "WakeOnLANDock", "AfterPowerLoss", "PXEIPV4NetworkStack"}
	if got := settingNames(l.Settings); !reflect.DeepEqual(got, want) {
		t.Fatalf("settings = %v, want %v", got, want)
	}
	if l.Settings[0].Value != "ACOnly" || !reflect.DeepEqual(l.Settings[0].PossibleValues, []string{"Disable", "ACOnly", "ACandBattery", "Enable"}) {
		t.Fatalf("WakeOnLAN = %+v", l.Settings[0])
	}
	if l.SettingCount != 10 || l.Truncated {
		t.Fatalf("count=%d truncated=%v", l.SettingCount, l.Truncated)
	}
	if l.PasswordState == nil || *l.PasswordState != 2 {
		t.Fatalf("password state = %v", l.PasswordState)
	}
	if l.MachineType == nil || *l.MachineType != "20U9" {
		t.Fatalf("machine type = %v", l.MachineType)
	}
	if !slices.Contains(l.Classes, "Lenovo_GetBiosSelections") || !slices.IsSorted(l.Classes) {
		t.Fatalf("classes = %v", l.Classes)
	}
	if l.SelectionCalls != 4 || l.SelectionErrors != 0 {
		t.Fatalf("selection calls=%d errors=%d", l.SelectionCalls, l.SelectionErrors)
	}
	raw := string(mustJSON(t, o))
	for _, secret := range []string{"EXAMPLE-ASSET", "Example Corp", "AssetTag", "OwnershipTag", "USBPortAccess", "MACAddress", "BootMode"} {
		if strings.Contains(raw, secret) {
			t.Errorf("observation carries %q", secret)
		}
	}
}

// Lenovo_GetBiosSelections is called only for allowlisted names, once each,
// and only by passing them as data on stdin, never inside the script.
func TestLenovoSelectionsOnlyForAllowlistedNames(t *testing.T) {
	f := newFakeRunner()
	f.out[lenovoReadScript] = fixture(t, "lenovo", "doc-derived", "thinkpad.json")
	f.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{})
	lenovoObserve(t, f, "20U9CTO1WW")
	var sel []fakeCall
	for _, c := range f.Calls() {
		if c.script == lenovoSelectionsScript {
			sel = append(sel, c)
		} else if c.script != lenovoReadScript {
			t.Fatalf("unexpected script %q", c.script)
		}
	}
	if len(sel) != 1 {
		t.Fatalf("%d selection runs, want 1", len(sel))
	}
	var req struct {
		Names []string `json:"names"`
	}
	if err := json.Unmarshal(sel[0].stdin, &req); err != nil {
		t.Fatalf("stdin %q: %v", sel[0].stdin, err)
	}
	if want := []string{"WakeOnLAN", "WakeOnLANDock", "AfterPowerLoss", "PXEIPV4NetworkStack"}; !reflect.DeepEqual(req.Names, want) {
		t.Fatalf("names = %v, want %v", req.Names, want)
	}
}

func TestLenovoSelectionsCappedAndDeduped(t *testing.T) {
	settings := []string{}
	for i := range 100 {
		settings = append(settings, fmt.Sprintf("WakeOnLAN%d,Enable", i), fmt.Sprintf("WakeOnLAN%d,Enable", i))
	}
	f := newFakeRunner()
	f.out[lenovoReadScript] = mustJSON(t, map[string]any{"settings": settings, "passwordState": 0, "classes": []string{"Lenovo_GetBiosSelections"}, "error": nil})
	f.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{})
	o := lenovoObserve(t, f, "11A4000AUS")
	var req struct {
		Names []string `json:"names"`
	}
	for _, c := range f.Calls() {
		if c.script == lenovoSelectionsScript {
			_ = json.Unmarshal(c.stdin, &req)
		}
	}
	if len(req.Names) == 0 || len(req.Names) > MaxSelectionCalls {
		t.Fatalf("%d names sent", len(req.Names))
	}
	seen := map[string]bool{}
	for _, n := range req.Names {
		if seen[n] {
			t.Fatalf("duplicate %q", n)
		}
		seen[n] = true
	}
	if o.Lenovo.SelectionCalls != len(req.Names) || !o.Lenovo.Truncated {
		t.Fatalf("calls=%d truncated=%v", o.Lenovo.SelectionCalls, o.Lenovo.Truncated)
	}
}

// Without the selections class, or when the call fails, possible values fall
// back to the optional list the setting itself carried, and failures are
// counted, not hidden.
func TestLenovoSelectionsFallback(t *testing.T) {
	f := newFakeRunner()
	f.out[lenovoReadScript] = mustJSON(t, map[string]any{
		"settings":      []string{"WakeOnLAN,ACOnly;[Optional:Disable,ACOnly]", "WakeOnLANDock,Enable"},
		"passwordState": 0,
		"classes":       []string{"Lenovo_BiosSetting"},
		"error":         nil,
	})
	o := lenovoObserve(t, f, "20U9CTO1WW")
	for _, c := range f.Calls() {
		if c.script == lenovoSelectionsScript {
			t.Fatal("selections called without the class")
		}
	}
	if !reflect.DeepEqual(o.Lenovo.Settings[0].PossibleValues, []string{"Disable", "ACOnly"}) || len(o.Lenovo.Settings[1].PossibleValues) != 0 {
		t.Fatalf("settings = %+v", o.Lenovo.Settings)
	}

	f2 := newFakeRunner()
	f2.out[lenovoReadScript] = mustJSON(t, map[string]any{
		"settings":      []string{"WakeOnLAN,ACOnly;[Optional:Disable,ACOnly]", "WakeOnLANDock,Enable"},
		"passwordState": 0,
		"classes":       []string{"Lenovo_GetBiosSelections"},
		"error":         nil,
	})
	f2.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{"WakeOnLANDock": "Disable,Enable"}, "WakeOnLAN")
	o2 := lenovoObserve(t, f2, "20U9CTO1WW")
	if o2.Lenovo.SelectionCalls != 2 || o2.Lenovo.SelectionErrors != 1 {
		t.Fatalf("calls=%d errors=%d", o2.Lenovo.SelectionCalls, o2.Lenovo.SelectionErrors)
	}
	if !reflect.DeepEqual(o2.Lenovo.Settings[0].PossibleValues, []string{"Disable", "ACOnly"}) ||
		!reflect.DeepEqual(o2.Lenovo.Settings[1].PossibleValues, []string{"Disable", "Enable"}) {
		t.Fatalf("settings = %+v", o2.Lenovo.Settings)
	}
	// A reply naming a setting that was not asked for is ignored.
	f3 := newFakeRunner()
	f3.out[lenovoReadScript] = f2.out[lenovoReadScript]
	f3.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{"AssetTag": "EXAMPLE", "WakeOnLAN": "A,B"})
	o3 := lenovoObserve(t, f3, "20U9CTO1WW")
	if strings.Contains(string(mustJSON(t, o3)), "EXAMPLE") {
		t.Fatal("an unrequested selection reply was kept")
	}
}

func TestLenovoIdeaPadAbsent(t *testing.T) {
	f := newFakeRunner()
	f.out[lenovoReadScript] = fixture(t, "lenovo", "doc-derived", "ideapad_absent.json")
	o := lenovoObserve(t, f, "82XX")
	if o.Interface != InterfaceAbsent || o.ErrorCode == nil || *o.ErrorCode != "0x80041010" {
		t.Fatalf("observation = %+v", o)
	}
	if len(f.Calls()) != 1 {
		t.Fatalf("%d scripts ran, want only the read", len(f.Calls()))
	}
	if o.Lenovo == nil || o.Lenovo.Settings == nil || o.Lenovo.Classes == nil {
		t.Fatalf("lenovo block must carry empty lists, not null: %+v", o.Lenovo)
	}
}

func TestLenovoMachineTypeAndBounds(t *testing.T) {
	for model, want := range map[string]*string{
		"20U9CTO1WW": strp("20U9"), "11A4000AUS": strp("11A4"), "20u9": strp("20U9"),
		"ThinkPad": nil, "20U": nil, "": nil, "20-U9": nil,
	} {
		got := lenovoMachineType(model)
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("machineType(%q) = %v, want %v", model, got, want)
		}
	}
	for _, c := range []struct {
		in   any
		want *int
	}{{2.0, intp(2)}, {0.0, intp(0)}, {-1.0, nil}, {70000.0, nil}, {1.5, nil}, {"2", nil}, {nil, nil}} {
		got := passwordStateOf(c.in)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("passwordState(%v) = %v", c.in, got)
		}
	}
	classes := lenovoClasses([]string{"Lenovo_Z", "Lenovo_A", "Lenovo_A", "NotLenovo", "Lenovo_bad name", strings.Repeat("Lenovo_x", 20), "Lenovo_B\x00"})
	if !reflect.DeepEqual(classes, []string{"Lenovo_A", "Lenovo_Z"}) {
		t.Fatalf("classes = %v", classes)
	}
}

func intp(i int) *int { return &i }
