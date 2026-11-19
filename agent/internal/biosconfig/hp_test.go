package biosconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func hpObserve(t *testing.T, f *fakeRunner) *Observation {
	t.Helper()
	o := observer(t, DetectWith("HP", "EliteDesk 800 G6", VendorHP, f.run)).Observe(context.Background())
	if o == nil {
		t.Fatal("nil observation")
	}
	return o
}

func TestHpReadParsesDocDerived(t *testing.T) {
	f := newFakeRunner()
	f.out[hpReadScript] = fixture(t, "hp", "doc-derived", "elitedesk.json")
	o := hpObserve(t, f)
	if o.Vendor != "hp" || o.Interface != InterfacePresent || o.ErrorCode != nil || o.HP == nil {
		t.Fatalf("observation = %+v", o)
	}
	got := settingNames(o.HP.Settings)
	want := []string{"Wake On LAN", "S5 Maximum Power Savings", "S4/S5 Wake on LAN", "Deep Sleep", "After Power Loss", "Network (PXE) Boot"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("settings = %v, want %v", got, want)
	}
	wol := o.HP.Settings[0]
	if wol.Value != "Boot to Hard Drive" || !slices.Contains(wol.PossibleValues, "Disable") || len(wol.PossibleValues) != 4 {
		t.Fatalf("Wake On LAN = %+v", wol)
	}
	if o.HP.SettingCount != 13 || o.HP.Truncated {
		t.Fatalf("count=%d truncated=%v", o.HP.SettingCount, o.HP.Truncated)
	}
	if o.HP.SetupPasswordSet == nil || !*o.HP.SetupPasswordSet || o.HP.PowerOnPasswordSet == nil || *o.HP.PowerOnPasswordSet {
		t.Fatalf("passwords = %v %v", o.HP.SetupPasswordSet, o.HP.PowerOnPasswordSet)
	}
	if o.HP.SureAdmin == nil || *o.HP.SureAdmin != "Disable" {
		t.Fatalf("sure admin = %v", o.HP.SureAdmin)
	}
	if o.HP.SettingInterface == nil || !*o.HP.SettingInterface {
		t.Fatalf("setting interface = %v", o.HP.SettingInterface)
	}
	// The read is one fixed script with nothing on stdin.
	if calls := f.Calls(); len(calls) != 1 || calls[0].script != hpReadScript || len(calls[0].stdin) != 0 {
		t.Fatalf("calls = %+v", calls)
	}
}

// No value of a denied or unlisted setting leaves the adapter: not the asset
// tag, not the ownership tag, not the serial.
func TestHpObservationCarriesNoDeniedValue(t *testing.T) {
	f := newFakeRunner()
	f.out[hpReadScript] = fixture(t, "hp", "doc-derived", "elitedesk.json")
	raw := string(mustJSON(t, hpObserve(t, f)))
	for _, secret := range []string{"EXAMPLE-ASSET", "Example Corp", "EXAMPLESERIAL", "Asset Tracking", "Ownership Tag", "Serial Number", "Num Lock", "Fast Boot"} {
		if strings.Contains(raw, secret) {
			t.Errorf("observation carries %q: %s", secret, raw)
		}
	}
}

func TestHpNamespaceAbsentIsInterfaceAbsent(t *testing.T) {
	f := newFakeRunner()
	f.out[hpReadScript] = fixture(t, "hp", "doc-derived", "consumer_absent.json")
	o := hpObserve(t, f)
	if o.Interface != InterfaceAbsent || o.ErrorCode == nil || *o.ErrorCode != "0x8004100E" {
		t.Fatalf("observation = %+v code=%v", o, o.ErrorCode)
	}
	if o.HP == nil || len(o.HP.Settings) != 0 || o.HP.Settings == nil {
		t.Fatalf("hp block = %+v (settings must be an empty list, not null)", o.HP)
	}
}

func TestErrorClassification(t *testing.T) {
	cases := []struct {
		fqid, native string
		iface, code  string
	}{
		{"HRESULT 0x8004100e,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "InvalidNamespace", InterfaceAbsent, "0x8004100E"},
		{"HRESULT 0x80041010,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "InvalidClass", InterfaceAbsent, "0x80041010"},
		{"HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "AccessDenied", InterfaceAccessDenied, "0x80041003"},
		{"HRESULT 0x80070005,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "", InterfaceAccessDenied, "0x80070005"},
		{"HRESULT 0x80041032,Microsoft.Management.Infrastructure.CimCmdlets.GetCimInstanceCommand", "", InterfaceError, "0x80041032"},
		{"", "InvalidNamespace", InterfaceAbsent, "0x8004100E"},
		{"", "InvalidClass", InterfaceAbsent, "0x80041010"},
		{"", "AccessDenied", InterfaceAccessDenied, "0x80041003"},
		{"SomethingElse", "Failed", InterfaceError, "Failed"},
		{"", "", InterfaceError, "unknown"},
		// Free text never becomes the code.
		{"", "bad code with spaces; and more", InterfaceError, "unknown"},
	}
	for _, c := range cases {
		iface, code := classifyScriptError(&scriptError{FQID: c.fqid, Native: c.native})
		if iface != c.iface || code != c.code {
			t.Errorf("(%q, %q) = (%s, %s), want (%s, %s)", c.fqid, c.native, iface, code, c.iface, c.code)
		}
	}
}

// A script that fails, hangs or prints garbage is an observation of
// interface: error, never a crash and never a claim.
func TestHpScriptFailureIsInterfaceError(t *testing.T) {
	for name, set := range map[string]func(f *fakeRunner){
		"run error": func(f *fakeRunner) { f.errs[hpReadScript] = errors.New("powershell exit 1: boom") },
		"timeout":   func(f *fakeRunner) { f.errs[hpReadScript] = context.DeadlineExceeded },
		"garbage":   func(f *fakeRunner) { f.out[hpReadScript] = []byte("not json") },
		"empty":     func(f *fakeRunner) { f.out[hpReadScript] = nil },
	} {
		f := newFakeRunner()
		set(f)
		o := hpObserve(t, f)
		if o.Interface != InterfaceError || o.ErrorCode == nil {
			t.Errorf("%s: observation = %+v", name, o)
			continue
		}
		if !errorCodeRe.MatchString(*o.ErrorCode) {
			t.Errorf("%s: code %q is not an identifier", name, *o.ErrorCode)
		}
		if name == "timeout" && *o.ErrorCode != "timeout" {
			t.Errorf("timeout code = %q", *o.ErrorCode)
		}
	}
}

func TestDenylistBeatsAllowlist(t *testing.T) {
	for _, name := range []string{
		"Asset Tracking Number", "Ownership Tag", "Wake On LAN Asset Mode", "Wake on LAN Owner", "Serial Wake",
		"UUID Wake", "Wake Password", "Wake PIN", "Wake Key", "Wake Cert", "Wake User", "Wake Email",
		"Wake Phone", "Name of Wake Site", "Wake Location", "WakeOnLANAssetTag",
	} {
		if allowedSettingName(name) {
			t.Errorf("%q allowed", name)
		}
	}
	for _, name := range []string{
		"Wake On LAN", "WakeOnLAN", "S5 Maximum Power Savings", "S4/S5 Wake on LAN", "Deep Sleep", "DeepSleep",
		"Power Saving", "After Power Loss", "AC Recovery", "AC Power Recovery", "ErP", "Network Boot", "PXE Boot", "LAN",
		"Integrated LAN", "WOL",
	} {
		if !allowedSettingName(name) {
			t.Errorf("%q not allowed", name)
		}
	}
	for _, name := range []string{"Fast Boot", "Num Lock State at Power-On", "Secure Boot", "Planar", ""} {
		if allowedSettingName(name) {
			t.Errorf("%q allowed", name)
		}
	}
}

func TestBoundsTruncate(t *testing.T) {
	long := strings.Repeat("v", 200)
	var enum []map[string]any
	for i := range 120 {
		possible := make([]string, 0, 40)
		for j := range 40 {
			possible = append(possible, fmt.Sprintf("%s-%d", long, j))
		}
		enum = append(enum, map[string]any{"name": fmt.Sprintf("Wake On LAN %d %s", i, long), "value": long, "possible": possible})
	}
	f := newFakeRunner()
	f.out[hpReadScript] = mustJSON(t, map[string]any{"enum": enum, "passwords": []any{}, "settingInterface": true, "error": nil})
	o := hpObserve(t, f)
	if o.HP.SettingCount != 120 || !o.HP.Truncated {
		t.Fatalf("count=%d truncated=%v", o.HP.SettingCount, o.HP.Truncated)
	}
	if n := len(o.HP.Settings); n == 0 || n > MaxObservedSettings {
		t.Fatalf("%d settings", n)
	}
	for _, s := range o.HP.Settings {
		if utf8.RuneCountInString(s.Name) > MaxObservedField || utf8.RuneCountInString(s.Value) > MaxObservedField {
			t.Fatalf("field over bound: %q / %q", s.Name, s.Value)
		}
		if len(s.PossibleValues) > MaxPossibleValues {
			t.Fatalf("%d possible values", len(s.PossibleValues))
		}
		for _, p := range s.PossibleValues {
			if utf8.RuneCountInString(p) > MaxObservedField {
				t.Fatalf("possible value over bound: %q", p)
			}
		}
	}
	b, _ := json.Marshal(o.HP.Settings)
	if len(b) > MaxSettingsBytes {
		t.Fatalf("settings %d bytes > %d", len(b), MaxSettingsBytes)
	}
}

func TestControlCharsStripped(t *testing.T) {
	f := newFakeRunner()
	f.out[hpReadScript] = mustJSON(t, map[string]any{
		"enum": []any{map[string]any{
			"name":     "Wake\x00 On\x1b LAN\u200b\u202e",
			"value":    "Boot\r\nto\tHard Drive\x7f",
			"possible": []string{"Dis\x07able", "", "  ", "\x00"},
		}},
		"passwords": []any{}, "settingInterface": false, "error": nil,
	})
	o := hpObserve(t, f)
	if len(o.HP.Settings) != 1 {
		t.Fatalf("settings = %+v", o.HP.Settings)
	}
	s := o.HP.Settings[0]
	if s.Name != "Wake On LAN" || s.Value != "BoottoHard Drive" {
		t.Fatalf("got %q / %q", s.Name, s.Value)
	}
	if !reflect.DeepEqual(s.PossibleValues, []string{"Disable"}) {
		t.Fatalf("possible = %q", s.PossibleValues)
	}
}

// Invalid UTF-8 from a BIOS string is dropped, never forwarded (the server's
// schema counts code points).
func TestInvalidUTF8Dropped(t *testing.T) {
	if got := cleanText("Wake\xff\xfe On LAN", MaxObservedField); got != "Wake On LAN" {
		t.Fatalf("cleanText = %q", got)
	}
	if got := cleanText(strings.Repeat("é", 100), 64); utf8.RuneCountInString(got) != 64 || !utf8.ValidString(got) {
		t.Fatalf("rune cut = %q", got)
	}
}

// A machine whose namespace exists but has no settings is absent, with a
// reason, rather than present with nothing.
func TestHpNoInstancesIsAbsent(t *testing.T) {
	f := newFakeRunner()
	f.out[hpReadScript] = mustJSON(t, map[string]any{"enum": []any{}, "passwords": []any{}, "settingInterface": nil, "error": nil})
	o := hpObserve(t, f)
	if o.Interface != InterfaceAbsent || o.ErrorCode == nil || *o.ErrorCode != "no_instances" {
		t.Fatalf("observation = %+v", o)
	}
}

func TestHpProtection(t *testing.T) {
	cases := map[string]struct {
		passwords []any
		sure      string
		want      Protection
	}{
		"setup set":        {[]any{map[string]any{"name": "Setup Password", "isSet": 1}}, "Disable", ProtectionSet},
		"sure admin":       {[]any{map[string]any{"name": "Setup Password", "isSet": 0}}, "Enable", ProtectionSet},
		"none":             {[]any{map[string]any{"name": "Setup Password", "isSet": 0}}, "Disable", ProtectionNone},
		"setup unreadable": {[]any{}, "Disable", ProtectionUnknown},
	}
	for name, c := range cases {
		f := newFakeRunner()
		enum := []any{map[string]any{"name": "Wake On LAN", "value": "Disable", "possible": []string{"Disable"}}}
		if c.sure != "" {
			enum = append(enum, map[string]any{"name": "Enhanced BIOS Authentication Mode", "value": c.sure, "possible": []string{"Disable", "Enable"}})
		}
		f.out[hpReadScript] = mustJSON(t, map[string]any{"enum": enum, "passwords": c.passwords, "settingInterface": true, "error": nil})
		a := DetectWith("HP", "EliteDesk 800 G6", VendorHP, f.run)
		got, err := a.Protection(context.Background())
		if err != nil || got != c.want {
			t.Errorf("%s: Protection = %v, %v; want %v", name, got, err, c.want)
		}
	}
}
